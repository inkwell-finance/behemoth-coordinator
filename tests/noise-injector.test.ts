/**
 * Tests for NoiseInjector
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NoiseInjector, NoiseConfig, ProposalScore } from '../src/results/noise-injector';

describe('NoiseInjector', () => {
  let injector: NoiseInjector;
  
  const config: NoiseConfig = {
    scoreVariancePercent: 5,        // ±5%
    falseRejectionRate: 0.1,        // 10%
    feedbackTemplates: [
      'Proposal shows potential improvement in backtesting.',
      'Marginal improvement detected.',
      'Performance below baseline. Proposal rejected.',
      'Generic evaluation complete.',
    ],
    templateRandomizationRate: 0.2, // 20%
  };

  beforeEach(() => {
    injector = new NoiseInjector(config);
  });

  describe('injectNoise', () => {
    it('adds variance to scores', () => {
      const score: ProposalScore = {
        proposalId: 'prop-123',
        relativeScore: 0.1,
        percentileRank: 0.8,
        isValid: true,
      };

      // Run multiple times to verify variance is added
      const results = new Set<number>();
      for (let i = 0; i < 100; i++) {
        const result = injector.injectNoise(score);
        if (result.relativeScore !== null) {
          results.add(Math.round(result.relativeScore * 1000) / 1000);
        }
      }

      // Should have some variation
      expect(results.size).toBeGreaterThan(1);
    });

    it('keeps score within variance bounds', () => {
      const score: ProposalScore = {
        proposalId: 'prop-123',
        relativeScore: 0.1,
        percentileRank: 0.8,
        isValid: true,
      };

      for (let i = 0; i < 100; i++) {
        const result = injector.injectNoise(score);
        if (result.relativeScore !== null) {
          const maxVariance = Math.abs(0.1) * (config.scoreVariancePercent / 100);
          expect(result.relativeScore).toBeGreaterThanOrEqual(0.1 - maxVariance);
          expect(result.relativeScore).toBeLessThanOrEqual(0.1 + maxVariance);
        }
      }
    });

    it('produces false rejections for valid proposals', () => {
      const score: ProposalScore = {
        proposalId: 'prop-123',
        relativeScore: 0.1,
        percentileRank: 0.9,
        isValid: true,
      };

      // With 10% false rejection rate, should see some false rejections
      let falseRejections = 0;
      const iterations = 1000;
      
      for (let i = 0; i < iterations; i++) {
        const result = injector.injectNoise(score);
        if (result._wasFalseRejection) {
          falseRejections++;
        }
      }

      // Should be roughly 10% (with some variance)
      const rate = falseRejections / iterations;
      expect(rate).toBeGreaterThan(0.05);
      expect(rate).toBeLessThan(0.20);
    });

    it('sets correct status based on score', () => {
      // High score -> pending_paper
      const highScore: ProposalScore = {
        proposalId: 'prop-high',
        relativeScore: 0.1,
        percentileRank: 0.9,
        isValid: true,
      };

      // Check multiple times due to noise
      let pendingCount = 0;
      for (let i = 0; i < 50; i++) {
        const result = injector.injectNoise(highScore);
        if (result.status === 'pending_paper' && !result._wasFalseRejection) {
          pendingCount++;
        }
      }
      expect(pendingCount).toBeGreaterThan(0);

      // Low score -> rejected
      const lowScore: ProposalScore = {
        proposalId: 'prop-low',
        relativeScore: -0.05,
        percentileRank: 0.1,
        isValid: true,
      };

      let rejectedCount = 0;
      for (let i = 0; i < 50; i++) {
        const result = injector.injectNoise(lowScore);
        if (result.status === 'rejected') {
          rejectedCount++;
        }
      }
      expect(rejectedCount).toBeGreaterThan(0);
    });

    it('returns feedback message', () => {
      const score: ProposalScore = {
        proposalId: 'prop-123',
        relativeScore: 0.05,
        percentileRank: 0.7,
        isValid: true,
      };

      const result = injector.injectNoise(score);
      expect(result.feedback).toBeTruthy();
      expect(typeof result.feedback).toBe('string');
    });
  });
});

