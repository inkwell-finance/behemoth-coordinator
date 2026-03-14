/**
 * Tests for RateLimiter
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimiter, RateLimitConfig } from '../src/gateway/rate-limiter';

describe('RateLimiter', () => {
  let limiter: RateLimiter;
  let currentTime: number;

  const config: RateLimitConfig = {
    maxPerDay: 3,
    maxPerQuarter: 50,
    cooldownMs: 60 * 60 * 1000, // 1 hour
  };

  const advanceTime = (ms: number) => {
    currentTime += ms;
  };

  beforeEach(() => {
    currentTime = Date.now();
    limiter = new RateLimiter(config, () => currentTime);
  });

  const researcher = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

  describe('canSubmit', () => {
    it('allows first submission', () => {
      const result = limiter.canSubmit(researcher);
      expect(result.allowed).toBe(true);
    });

    it('enforces cooldown between submissions', () => {
      limiter.recordSubmission(researcher);
      
      const result = limiter.canSubmit(researcher);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Cooldown period active');
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('allows submission after cooldown', () => {
      limiter.recordSubmission(researcher);

      // Advance time past cooldown
      advanceTime(config.cooldownMs + 1000);

      const result = limiter.canSubmit(researcher);
      expect(result.allowed).toBe(true);
    });

    it('enforces daily limit', () => {
      // Submit max per day
      for (let i = 0; i < config.maxPerDay; i++) {
        limiter.recordSubmission(researcher);
        advanceTime(config.cooldownMs + 1000);
      }

      const result = limiter.canSubmit(researcher);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Daily limit reached');
    });

    it('resets daily limit on new day', () => {
      // Submit max per day
      for (let i = 0; i < config.maxPerDay; i++) {
        limiter.recordSubmission(researcher);
        advanceTime(config.cooldownMs + 1000);
      }

      // Advance to next day (25 hours to be safe)
      advanceTime(25 * 60 * 60 * 1000);

      const result = limiter.canSubmit(researcher);
      expect(result.allowed).toBe(true);
    });

    it('tracks multiple researchers independently', () => {
      const researcher2 = 'DifferentResearcherPubKeyHere12345678901234567890';
      
      limiter.recordSubmission(researcher);
      
      // First researcher in cooldown, second should be allowed
      expect(limiter.canSubmit(researcher).allowed).toBe(false);
      expect(limiter.canSubmit(researcher2).allowed).toBe(true);
    });
  });

  describe('recordSubmission', () => {
    it('increments daily count', () => {
      limiter.recordSubmission(researcher);
      advanceTime(config.cooldownMs + 1000);
      limiter.recordSubmission(researcher);
      advanceTime(config.cooldownMs + 1000);

      // After 2 submissions, 1 more should be allowed (maxPerDay = 3)
      expect(limiter.canSubmit(researcher).allowed).toBe(true);

      limiter.recordSubmission(researcher);
      advanceTime(config.cooldownMs + 1000);

      // Now at daily limit
      expect(limiter.canSubmit(researcher).allowed).toBe(false);
    });
  });
});

