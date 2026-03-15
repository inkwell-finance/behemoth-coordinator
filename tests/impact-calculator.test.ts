/**
 * Tests for ImpactCalculator
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ImpactCalculator, ImpactCalculatorConfig } from '../src/results/impact-calculator';
import { ResearchImpact } from '@inkwell-finance/behemoth-protocol';

describe('ImpactCalculator', () => {
  let calculator: ImpactCalculator;
  
  const config: ImpactCalculatorConfig = {
    maxSingleImpact: 0.1,         // Cap at 10%
    paperTradeDaysRequired: 7,    // 7 days minimum
  };

  beforeEach(() => {
    calculator = new ImpactCalculator(config);
  });

  describe('calculateEpochImpacts', () => {
    it('calculates scores for single researcher', () => {
      const impacts: ResearchImpact[] = [
        {
          proposalId: 'prop-1',
          researcher: 'researcher-a',
          accepted: true,
          pnlDelta: 0.05,
          paperTradeDays: 14,
          evaluatedAt: Date.now(),
        },
      ];

      const scores = calculator.calculateEpochImpacts(impacts);
      
      expect(scores.has('researcher-a')).toBe(true);
      expect(scores.get('researcher-a')).toBe(1); // Only researcher, so 100%
    });

    it('normalizes scores across researchers', () => {
      const impacts: ResearchImpact[] = [
        {
          proposalId: 'prop-1',
          researcher: 'researcher-a',
          accepted: true,
          pnlDelta: 0.06,
          paperTradeDays: 14,
          evaluatedAt: Date.now(),
        },
        {
          proposalId: 'prop-2',
          researcher: 'researcher-b',
          accepted: true,
          pnlDelta: 0.04,
          paperTradeDays: 10,
          evaluatedAt: Date.now(),
        },
      ];

      const scores = calculator.calculateEpochImpacts(impacts);
      
      // Total should sum to 1
      const total = Array.from(scores.values()).reduce((a, b) => a + b, 0);
      expect(total).toBeCloseTo(1.0, 5);
      
      // A should have higher score (0.06 vs 0.04)
      expect(scores.get('researcher-a')!).toBeGreaterThan(scores.get('researcher-b')!);
    });

    it('ignores rejected proposals', () => {
      const impacts: ResearchImpact[] = [
        {
          proposalId: 'prop-1',
          researcher: 'researcher-a',
          accepted: true,
          pnlDelta: 0.05,
          paperTradeDays: 14,
          evaluatedAt: Date.now(),
        },
        {
          proposalId: 'prop-2',
          researcher: 'researcher-b',
          accepted: false, // Rejected
          pnlDelta: 0.10,
          paperTradeDays: 14,
          evaluatedAt: Date.now(),
        },
      ];

      const scores = calculator.calculateEpochImpacts(impacts);

      expect(scores.has('researcher-a')).toBe(true);
      expect(scores.get('researcher-a')).toBe(1); // Gets 100% since B has 0 score
      expect(scores.get('researcher-b')).toBe(0); // Score is 0 due to rejection
    });

    it('ignores negative pnl delta', () => {
      const impacts: ResearchImpact[] = [
        {
          proposalId: 'prop-1',
          researcher: 'researcher-a',
          accepted: true,
          pnlDelta: 0.05,
          paperTradeDays: 14,
          evaluatedAt: Date.now(),
        },
        {
          proposalId: 'prop-2',
          researcher: 'researcher-b',
          accepted: true,
          pnlDelta: -0.02, // Negative
          paperTradeDays: 14,
          evaluatedAt: Date.now(),
        },
      ];

      const scores = calculator.calculateEpochImpacts(impacts);

      // B has 0 score due to negative pnl
      expect(scores.get('researcher-b')).toBe(0);
      // A gets 100% since B has 0 score
      expect(scores.get('researcher-a')).toBe(1);
    });

    it('ignores insufficient paper trade days', () => {
      const impacts: ResearchImpact[] = [
        {
          proposalId: 'prop-1',
          researcher: 'researcher-a',
          accepted: true,
          pnlDelta: 0.05,
          paperTradeDays: 14,
          evaluatedAt: Date.now(),
        },
        {
          proposalId: 'prop-2',
          researcher: 'researcher-b',
          accepted: true,
          pnlDelta: 0.10,
          paperTradeDays: 3, // Below threshold
          evaluatedAt: Date.now(),
        },
      ];

      const scores = calculator.calculateEpochImpacts(impacts);

      // B has 0 score due to insufficient paper trade days
      expect(scores.get('researcher-b')).toBe(0);
      // A gets 100%
      expect(scores.get('researcher-a')).toBe(1);
    });

    it('caps individual impact at configured maximum', () => {
      const impacts: ResearchImpact[] = [
        {
          proposalId: 'prop-1',
          researcher: 'researcher-a',
          accepted: true,
          pnlDelta: 0.20, // Above cap of 0.10
          paperTradeDays: 14,
          evaluatedAt: Date.now(),
        },
        {
          proposalId: 'prop-2',
          researcher: 'researcher-b',
          accepted: true,
          pnlDelta: 0.05,
          paperTradeDays: 14,
          evaluatedAt: Date.now(),
        },
      ];

      const scores = calculator.calculateEpochImpacts(impacts);
      
      // A's impact capped at 0.10, B at 0.05
      // So A gets 0.10/(0.10+0.05) = 0.667
      expect(scores.get('researcher-a')!).toBeCloseTo(0.667, 2);
      expect(scores.get('researcher-b')!).toBeCloseTo(0.333, 2);
    });

    it('returns empty map when no positive impact', () => {
      const impacts: ResearchImpact[] = [
        {
          proposalId: 'prop-1',
          researcher: 'researcher-a',
          accepted: false,
          pnlDelta: 0.05,
          paperTradeDays: 14,
          evaluatedAt: Date.now(),
        },
      ];

      const scores = calculator.calculateEpochImpacts(impacts);
      
      expect(scores.size).toBe(0);
    });
  });

  describe('generateEpochSummary', () => {
    it('generates correct summary', () => {
      const impacts: ResearchImpact[] = [
        { proposalId: 'p1', researcher: 'r1', accepted: true, pnlDelta: 0.05, paperTradeDays: 14, evaluatedAt: Date.now() },
        { proposalId: 'p2', researcher: 'r2', accepted: true, pnlDelta: 0.03, paperTradeDays: 14, evaluatedAt: Date.now() },
        { proposalId: 'p3', researcher: 'r3', accepted: false, pnlDelta: 0.01, paperTradeDays: 14, evaluatedAt: Date.now() },
      ];

      const scores = calculator.calculateEpochImpacts(impacts);
      const summary = calculator.generateEpochSummary(42, impacts, scores);

      expect(summary.epochId).toBe(42);
      expect(summary.totalProposals).toBe(3);
      expect(summary.acceptedProposals).toBe(2);
      expect(summary.totalPositiveImpact).toBeCloseTo(0.08, 5);
      // All researchers tracked in scores map (including r3 with 0 score)
      expect(summary.topResearchers.length).toBe(3);
      // But only r1 and r2 have non-zero scores
      expect(summary.topResearchers.filter(r => r.score > 0).length).toBe(2);
    });
  });
});

