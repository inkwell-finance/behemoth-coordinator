/**
 * Rate limiting for research proposals.
 * Prevents exploration attacks.
 *
 * All counters are stored in Redis so they survive restarts.
 *
 * Redis layout (all keys use INCR so they are atomic):
 *   behemoth:ratelimit:<pubkey>:daily        STRING  integer counter
 *   behemoth:ratelimit:<pubkey>:quarterly    STRING  integer counter
 *   behemoth:ratelimit:<pubkey>:last         STRING  Unix timestamp (ms) of last submission
 *
 * TTLs:
 *   daily     — expires at the next UTC midnight (dynamic EXPIREAT)
 *   quarterly — expires at the next quarter boundary (dynamic EXPIREAT)
 *   last      — same TTL as quarterly (long-lived)
 */

import type Redis from 'ioredis';
import { getRedisClient } from '../shared/redis.js';
import logger from '../shared/logger.js';

export interface RateLimitConfig {
  // These values loaded from PRIVATE config
  maxPerDay: number;        // e.g., 3
  maxPerQuarter: number;    // e.g., 150
  cooldownMs: number;       // e.g., 3600000 (1 hour)
}

// ---------------------------------------------------------------------------
// Stake-based tier system
// ---------------------------------------------------------------------------

/**
 * Rate limits for a given researcher tier.
 *
 * TODO: When on-chain stake verification is available, look up the researcher's
 * staked amount and assign a higher tier (e.g., STAKED_TIER, WHALE_TIER) with
 * more generous limits.  For now everyone gets DEFAULT_TIER.
 */
export interface RateTier {
  maxDaily: number;
  maxQuarterly: number;
  cooldownMs: number;
}

export const DEFAULT_TIER: RateTier = {
  maxDaily: 3,
  maxQuarterly: 150,
  cooldownMs: 3_600_000, // 1 hour
};

export const SILVER_TIER: RateTier = {
  maxDaily: 6,        // 2x limits
  maxQuarterly: 300,
  cooldownMs: 3_600_000,
};

export const GOLD_TIER: RateTier = {
  maxDaily: 15,       // 5x limits
  maxQuarterly: 750,
  cooldownMs: 3_600_000,
};

// ---------------------------------------------------------------------------
// Stake lookup and tier assignment
// ---------------------------------------------------------------------------

const STAKE_TIER_CACHE_KEY = (pubkey: string) => `behemoth:tier:${pubkey}`;
const STAKE_KEY = (pubkey: string) => `behemoth:stake:${pubkey}`;
const TIER_CACHE_TTL_SEC = 300; // 5 minutes

/**
 * Looks up the researcher's staked amount and returns the corresponding tier.
 * Caches the result in Redis with a 5-minute TTL.
 * Falls back to DEFAULT_TIER if Redis lookup fails.
 */
export async function getTierForResearcher(pubkey: string): Promise<RateTier> {
  const redis = getRedisClient();

  // Try to get cached tier
  try {
    const cachedTier = await redis.get(STAKE_TIER_CACHE_KEY(pubkey));
    if (cachedTier) {
      return parseTier(cachedTier);
    }
  } catch (err) {
    logger.warn({ err, pubkey }, 'Failed to read tier cache');
  }

  // Look up stake amount
  let stakeAmount = 0;
  try {
    const stakeRaw = await redis.get(STAKE_KEY(pubkey));
    if (stakeRaw) {
      stakeAmount = parseInt(stakeRaw, 10);
    }
  } catch (err) {
    logger.warn({ err, pubkey }, 'Failed to read stake, falling back to DEFAULT_TIER');
    return DEFAULT_TIER;
  }

  // Map stake to tier
  let tier = DEFAULT_TIER;
  if (stakeAmount >= 10000) {
    tier = GOLD_TIER;
  } else if (stakeAmount >= 1000) {
    tier = SILVER_TIER;
  }

  // Cache the tier
  try {
    await redis.setex(STAKE_TIER_CACHE_KEY(pubkey), TIER_CACHE_TTL_SEC, serializeTier(tier));
  } catch (err) {
    logger.warn({ err, pubkey }, 'Failed to cache tier');
    // Continue anyway, just won't be cached
  }

  return tier;
}

/**
 * Serializes a RateTier to a string for Redis storage.
 */
function serializeTier(tier: RateTier): string {
  return JSON.stringify(tier);
}

/**
 * Deserializes a RateTier from a Redis string.
 */
function parseTier(data: string): RateTier {
  try {
    return JSON.parse(data) as RateTier;
  } catch {
    return DEFAULT_TIER;
  }
}

// ---------------------------------------------------------------------------
// Pubkey validation
// ---------------------------------------------------------------------------

/** Base58 alphabet (Bitcoin/Solana variant — no 0, O, I, l). */
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Returns true if the value looks like a valid base58-encoded public key
 * (32–44 characters, base58 alphabet).  This is a format check only — it does
 * NOT verify the key against a signature.
 */
export function isValidResearcherPubkey(value: string): boolean {
  return BASE58_RE.test(value);
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

const KEY = {
  daily:     (pk: string) => `behemoth:ratelimit:${pk}:daily`,
  quarterly: (pk: string) => `behemoth:ratelimit:${pk}:quarterly`,
  last:      (pk: string) => `behemoth:ratelimit:${pk}:last`,
} as const;

// ---------------------------------------------------------------------------
// RateLimiter
// ---------------------------------------------------------------------------

export class RateLimiter {
  private redis: Redis;
  private getNow: () => number;

  constructor(private config: RateLimitConfig, getNow?: () => number) {
    this.redis = getRedisClient();
    this.getNow = getNow ?? (() => Date.now());
  }

  /**
   * Check if researcher can submit a proposal.
   * Reads current counters from Redis; does NOT modify state.
   */
  async canSubmit(researcher: string): Promise<{ allowed: boolean; reason?: string; retryAfter?: number }> {
    const now = this.getNow();

    // Get the researcher's tier based on stake
    const tier = await getTierForResearcher(researcher);

    // --- cooldown ---
    const lastRaw = await this.redis.get(KEY.last(researcher));
    const lastSubmission = lastRaw ? parseInt(lastRaw, 10) : 0;
    const timeSinceLast = now - lastSubmission;
    if (timeSinceLast < tier.cooldownMs) {
      return {
        allowed: false,
        reason: 'Cooldown period active',
        retryAfter: tier.cooldownMs - timeSinceLast,
      };
    }

    // --- daily limit ---
    const dailyRaw = await this.redis.get(KEY.daily(researcher));
    const dailyCount = dailyRaw ? parseInt(dailyRaw, 10) : 0;
    if (dailyCount >= tier.maxDaily) {
      const dayEnd = this.getNextDayStartMs(now);
      return {
        allowed: false,
        reason: 'Daily limit reached',
        retryAfter: dayEnd - now,
      };
    }

    // --- quarterly limit ---
    const quarterlyRaw = await this.redis.get(KEY.quarterly(researcher));
    const quarterlyCount = quarterlyRaw ? parseInt(quarterlyRaw, 10) : 0;
    if (quarterlyCount >= tier.maxQuarterly) {
      const quarterEnd = this.getNextQuarterStartMs(now);
      return {
        allowed: false,
        reason: 'Quarterly limit reached',
        retryAfter: quarterEnd - now,
      };
    }

    return { allowed: true };
  }

  /**
   * Record a submission for a researcher.
   * Atomically increments daily and quarterly counters and sets expiry.
   * Must be called only after canSubmit returns { allowed: true }.
   */
  async recordSubmission(researcher: string): Promise<void> {
    const now = this.getNow();
    const pipeline = this.redis.pipeline();

    // Increment daily counter and set expiry to next UTC midnight
    const dailyKey = KEY.daily(researcher);
    const nextMidnightSec = Math.floor(this.getNextDayStartMs(now) / 1000);
    pipeline.incr(dailyKey);
    pipeline.expireat(dailyKey, nextMidnightSec);

    // Increment quarterly counter and set expiry to next quarter boundary
    const quarterlyKey = KEY.quarterly(researcher);
    const nextQuarterSec = Math.floor(this.getNextQuarterStartMs(now) / 1000);
    pipeline.incr(quarterlyKey);
    pipeline.expireat(quarterlyKey, nextQuarterSec);

    // Record last submission timestamp (expires with the quarter)
    const lastKey = KEY.last(researcher);
    pipeline.set(lastKey, String(now));
    pipeline.expireat(lastKey, nextQuarterSec);

    await pipeline.exec();
  }

  // --------------------------------------------------------------------------
  // Time helpers
  // --------------------------------------------------------------------------

  /** Unix ms of the start of the next UTC calendar day. */
  private getNextDayStartMs(now: number): number {
    const d = new Date(now);
    d.setUTCHours(24, 0, 0, 0); // rolls to next day at 00:00:00 UTC
    return d.getTime();
  }

  /** Unix ms of the start of the next UTC calendar quarter. */
  private getNextQuarterStartMs(now: number): number {
    const d = new Date(now);
    const currentQuarter = Math.floor(d.getUTCMonth() / 3);
    const nextQuarterMonth = (currentQuarter + 1) * 3; // 3, 6, 9, or 12
    if (nextQuarterMonth >= 12) {
      d.setUTCFullYear(d.getUTCFullYear() + 1, 0, 1);
    } else {
      d.setUTCMonth(nextQuarterMonth, 1);
    }
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  }
}
