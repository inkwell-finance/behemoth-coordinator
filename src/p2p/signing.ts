/**
 * Ed25519 signing utilities for P2P message authentication.
 * Mirrors the pattern used in behemoth-researcher/src/wallet/solana.ts.
 */

import { createPrivateKey, createPublicKey, sign, verify, generateKeyPairSync } from 'crypto';
import logger from '../shared/logger.js';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function encodeBase58(bytes: Uint8Array): string {
  let leadingZeros = 0;
  for (const b of bytes) {
    if (b === 0) leadingZeros++;
    else break;
  }
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  return (
    '1'.repeat(leadingZeros) +
    digits
      .reverse()
      .map(d => BASE58_ALPHABET[d])
      .join('')
  );
}

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

export interface P2PSigningKey {
  publicKeyBase58: string;
  sign(message: string): string;
}

/**
 * Load or generate an Ed25519 signing key for the coordinator.
 * If COORDINATOR_KEYPAIR env var is set (64-number JSON array, Solana format),
 * uses that. Otherwise generates an ephemeral key pair.
 */
export function loadP2PSigningKey(): P2PSigningKey {
  let privateKeyObj: ReturnType<typeof createPrivateKey>;
  let publicKeyBase58: string;

  const keypairEnv = process.env.COORDINATOR_KEYPAIR;
  if (keypairEnv) {
    try {
      const raw = JSON.parse(keypairEnv) as number[];
      const bytes = new Uint8Array(raw);
      if (bytes.length !== 64) throw new Error(`Expected 64 bytes, got ${bytes.length}`);
      const seed = bytes.slice(0, 32);
      const pubkeyBytes = bytes.slice(32, 64);
      const oid = Buffer.from('302e020100300506032b657004220420', 'hex');
      const der = Buffer.concat([oid, seed]);
      privateKeyObj = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
      publicKeyBase58 = encodeBase58(pubkeyBytes);
      logger.info('Loaded coordinator signing key from COORDINATOR_KEYPAIR');
    } catch (err) {
      logger.warn({ err }, 'Failed to load COORDINATOR_KEYPAIR, generating ephemeral key');
      ({ privateKeyObj, publicKeyBase58 } = generateEphemeral());
    }
  } else {
    logger.warn('No COORDINATOR_KEYPAIR env var — generating ephemeral Ed25519 signing key');
    ({ privateKeyObj, publicKeyBase58 } = generateEphemeral());
  }

  const capturedPriv = privateKeyObj;

  return {
    publicKeyBase58,
    sign(message: string): string {
      const sig = sign(null, Buffer.from(message, 'utf8'), capturedPriv);
      return Buffer.from(sig).toString('base64');
    },
  };
}

function generateEphemeral(): { privateKeyObj: ReturnType<typeof createPrivateKey>; publicKeyBase58: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pubkeyDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const pubkeyBytes = pubkeyDer.slice(pubkeyDer.length - 32);
  return {
    privateKeyObj: privateKey,
    publicKeyBase58: encodeBase58(pubkeyBytes),
  };
}

/**
 * Verify an Ed25519 signature produced by P2PSigningKey.sign().
 *
 * @param publicKeyBase58 - Base58-encoded 32-byte Ed25519 public key
 * @param message         - The original plaintext message that was signed
 * @param signatureBase64 - Base64-encoded 64-byte signature
 */
export function verifyP2PSignature(
  publicKeyBase58: string,
  message: string,
  signatureBase64: string,
): boolean {
  try {
    const pubkeyBytes = decodeBase58(publicKeyBase58);
    if (pubkeyBytes.length !== 32) return false;
    const spkiHeader = Buffer.from('302a300506032b6570032100', 'hex');
    const der = Buffer.concat([spkiHeader, pubkeyBytes]);
    const publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });
    const msgBuf = Buffer.from(message, 'utf8');
    const sigBuf = Buffer.from(signatureBase64, 'base64');
    return verify(null, msgBuf, publicKey, sigBuf);
  } catch {
    return false;
  }
}
