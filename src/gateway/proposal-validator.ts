/**
 * Validates research proposals before processing.
 * This code is open source for auditability.
 *
 * Checks performed in order:
 *  1. Signature validity  — Ed25519 over the canonical payload
 *  2. Nonce deduplication — replay protection (Redis SETNX, 1-hour TTL)
 *  3. Timestamp recency   — reject proposals older than 5 minutes
 *  4. Schema / slot rules — all modifications within allowed ranges
 */

import { createPublicKey, verify as cryptoVerify } from 'crypto';
import { ResearchProposal, SlotSchema, ValidationResult } from '@inkwell-finance/behemoth-protocol';
import { getRedisClient } from '../shared/redis.js';
import { duplicateNonceRejectionsTotal } from '../metrics.js';
import type Redis from 'ioredis';

// ---------------------------------------------------------------------------
// Base58 decoder (no external deps — mirrors researcher/wallet/solana.ts)
// ---------------------------------------------------------------------------

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function decodeBase58(s: string): Uint8Array {
  const bytes = [0];
  for (const char of s) {
    const value = BASE58_ALPHABET.indexOf(char);
    if (value < 0) throw new Error(`Invalid base58 character: ${char}`);
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  let leadingZeros = 0;
  for (const char of s) {
    if (char === '1') leadingZeros++;
    else break;
  }

  return new Uint8Array([...new Array(leadingZeros).fill(0), ...bytes.reverse()]);
}

// ---------------------------------------------------------------------------
// Canonical payload serialization — must be byte-for-byte identical to the
// implementation in behemoth-researcher/src/researcher/proposal-builder.ts
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON serialization: recursively sorts object keys so the
 * output is byte-for-byte identical regardless of insertion order.
 */
function canonicalJson(obj: unknown): string {
  return JSON.stringify(obj, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : v
  );
}

/**
 * Reproduce the canonical JSON string that was signed by the researcher.
 * Only signable fields are included; `signature`, `traceId`, `hypothesis`,
 * and `methodology` are deliberately excluded.
 */
function canonicalizeProposalPayload(proposal: ResearchProposal): string {
  const sortedMods = [...proposal.modifications].sort((a, b) =>
    a.slotId < b.slotId ? -1 : a.slotId > b.slotId ? 1 : 0
  );

  const payload = {
    modifications: sortedMods,
    nonce: proposal.nonce,
    proposalId: proposal.proposalId,
    researcher: proposal.researcher,
    timestamp: proposal.timestamp,
  };

  return canonicalJson(payload);
}

// ---------------------------------------------------------------------------
// Ed25519 signature verification
// ---------------------------------------------------------------------------

/**
 * Verify an Ed25519 signature.
 *
 * @param publicKeyBase58 - Base58-encoded 32-byte raw public key
 * @param message         - UTF-8 text that was signed
 * @param signatureBase64 - Base64-encoded 64-byte signature
 */
function verifyEd25519(
  publicKeyBase58: string,
  message: string,
  signatureBase64: string
): boolean {
  try {
    const pubkeyBytes = decodeBase58(publicKeyBase58);
    if (pubkeyBytes.length !== 32) return false;

    // DER-encode as SubjectPublicKeyInfo:
    //   302a300506032b6570032100 + <32 bytes raw pubkey>
    const spkiHeader = Buffer.from('302a300506032b6570032100', 'hex');
    const der = Buffer.concat([spkiHeader, Buffer.from(pubkeyBytes)]);
    const publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });

    const msgBuf = Buffer.from(message, 'utf8');
    const sigBuf = Buffer.from(signatureBase64, 'base64');

    return cryptoVerify(null, msgBuf, publicKey, sigBuf);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Nonce store — Redis-backed with 1-hour TTL (SETNX)
// ---------------------------------------------------------------------------

const NONCE_TTL_SECONDS = 60 * 60; // 1 hour

/**
 * NonceStore provides replay protection by remembering recently seen nonces.
 * Uses Redis SETNX so that nonce deduplication is safe across multiple
 * coordinator processes.
 */
export class NonceStore {
  private readonly redis: Redis;

  constructor(redis?: Redis) {
    this.redis = redis ?? getRedisClient();
  }

  /**
   * Returns true if `nonce` has not been seen before (and records it).
   * Returns false if the nonce is a duplicate (replay attempt).
   */
  async checkAndRecordNonce(nonce: string): Promise<boolean> {
    const key = `coordinator:nonce:${nonce}`;
    const result = await this.redis.set(key, '1', 'EX', NONCE_TTL_SECONDS, 'NX');
    return result === 'OK'; // true if nonce is new, false if already exists
  }
}

// ---------------------------------------------------------------------------
// ProposalValidator
// ---------------------------------------------------------------------------

const MAX_PROPOSAL_AGE_MS = 5 * 60 * 1000; // 5 minutes

export interface ProposalValidatorConfig {
  slotSchema: SlotSchema;
  maxModificationsPerProposal: number;
  /** Optional nonce store — a default Redis-backed store is used when omitted. */
  nonceStore?: NonceStore;
}

export class ProposalValidator {
  private readonly nonceStore: NonceStore;

  constructor(private config: ProposalValidatorConfig) {
    this.nonceStore = config.nonceStore ?? new NonceStore();
  }

  /**
   * Validate a research proposal.
   *
   * Checks (in order):
   *  1. Signature validity
   *  2. Nonce deduplication
   *  3. Timestamp recency (≤ 5 minutes old)
   *  4. Modification count
   *  5. Per-slot range / type / step validation
   *  6. Duplicate slot check
   */
  async validate(proposal: ResearchProposal): Promise<ValidationResult> {
    // -----------------------------------------------------------------------
    // 1. Signature verification — FIRST, before any expensive processing
    // -----------------------------------------------------------------------
    if (!proposal.signature || !proposal.nonce) {
      return {
        valid: false,
        errors: ['Invalid signature'],
        proposalId: proposal.proposalId,
      };
    }

    const canonical = canonicalizeProposalPayload(proposal);
    const sigValid = verifyEd25519(proposal.researcher, canonical, proposal.signature);
    if (!sigValid) {
      return {
        valid: false,
        errors: ['Invalid signature'],
        proposalId: proposal.proposalId,
      };
    }

    // -----------------------------------------------------------------------
    // 2. Nonce deduplication
    // -----------------------------------------------------------------------
    if (!await this.nonceStore.checkAndRecordNonce(proposal.nonce)) {
      duplicateNonceRejectionsTotal.inc();
      return {
        valid: false,
        errors: ['Duplicate nonce — possible replay attack'],
        proposalId: proposal.proposalId,
      };
    }

    // -----------------------------------------------------------------------
    // 3. Timestamp recency
    // -----------------------------------------------------------------------
    const age = Date.now() - proposal.timestamp;
    if (age > MAX_PROPOSAL_AGE_MS) {
      return {
        valid: false,
        errors: [`Proposal timestamp too old: ${Math.round(age / 1000)}s ago (max ${MAX_PROPOSAL_AGE_MS / 1000}s)`],
        proposalId: proposal.proposalId,
      };
    }
    if (age < -30_000) {
      // Allow 30s of clock skew in the future direction.
      return {
        valid: false,
        errors: ['Proposal timestamp is too far in the future'],
        proposalId: proposal.proposalId,
      };
    }

    // -----------------------------------------------------------------------
    // 4–6. Schema / slot validation
    // -----------------------------------------------------------------------
    const errors: string[] = [];

    if (!proposal.modifications || proposal.modifications.length === 0) {
      errors.push('Proposal must contain at least one modification');
    }

    if (proposal.modifications && proposal.modifications.length > this.config.maxModificationsPerProposal) {
      errors.push(`Too many modifications: ${proposal.modifications.length} > ${this.config.maxModificationsPerProposal}`);
    }

    for (const mod of proposal.modifications) {
      const slotDef = this.config.slotSchema.slots.find(s => s.slotId === mod.slotId);

      if (!slotDef) {
        errors.push(`Unknown slot: ${mod.slotId}`);
        continue;
      }

      if (slotDef.valueType === 'float' || slotDef.valueType === 'int') {
        if (typeof mod.proposedValue !== 'number') {
          errors.push(`Slot ${mod.slotId} requires numeric value`);
          continue;
        }

        if (mod.proposedValue < slotDef.range.min || mod.proposedValue > slotDef.range.max) {
          errors.push(`Slot ${mod.slotId} value ${mod.proposedValue} outside range [${slotDef.range.min}, ${slotDef.range.max}]`);
        }

        if (slotDef.range.step) {
          const steps = (mod.proposedValue - slotDef.range.min) / slotDef.range.step;
          if (Math.abs(steps - Math.round(steps)) > 0.001) {
            errors.push(`Slot ${mod.slotId} value ${mod.proposedValue} not aligned to step ${slotDef.range.step}`);
          }
        }
      }

      if (slotDef.valueType === 'enum') {
        if (!slotDef.range.enumValues?.includes(String(mod.proposedValue))) {
          errors.push(`Slot ${mod.slotId} value must be one of: ${slotDef.range.enumValues?.join(', ')}`);
        }
      }
    }

    const slotIds = proposal.modifications.map(m => m.slotId);
    const uniqueSlotIds = new Set(slotIds);
    if (slotIds.length !== uniqueSlotIds.size) {
      errors.push('Duplicate slot modifications not allowed');
    }

    return {
      valid: errors.length === 0,
      errors,
      proposalId: proposal.proposalId,
    };
  }
}
