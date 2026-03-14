/**
 * Calculates research impact for reward distribution.
 */

import { ResearchImpact, EpochSummary } from '@inkwell-finance/protocol';

export interface ImpactCalculatorConfig {
  maxSingleImpact: number;  // Cap on single proposal impact (e.g., 0.1 = 10%)
  paperTradeDaysRequired: number;  // Minimum days to count (e.g., 7)
}

export class ImpactCalculator {
  constructor(private config: ImpactCalculatorConfig) {}

  /**
   * Calculate impact scores for all researchers in an epoch.
   */
  calculateEpochImpacts(impacts: ResearchImpact[]): Map<string, number> {
    const researcherScores = new Map<string, number>();

    // Group by researcher
    const byResearcher = new Map<string, ResearchImpact[]>();
    for (const impact of impacts) {
      const existing = byResearcher.get(impact.researcher) || [];
      existing.push(impact);
      byResearcher.set(impact.researcher, existing);
    }

    // Calculate raw scores
    for (const [researcher, researcherImpacts] of byResearcher) {
      const score = this.calculateResearcherScore(researcherImpacts);
      researcherScores.set(researcher, score);
    }

    // Normalize
    return this.normalizeScores(researcherScores);
  }

  /**
   * Calculate raw score for a single researcher.
   * Only counts accepted proposals with positive PnL delta.
   */
  private calculateResearcherScore(impacts: ResearchImpact[]): number {
    let totalScore = 0;

    for (const impact of impacts) {
      // Skip if not accepted or negative impact
      if (!impact.accepted || impact.pnlDelta <= 0) {
        continue;
      }

      // Skip if insufficient paper trading
      if (impact.paperTradeDays < this.config.paperTradeDaysRequired) {
        continue;
      }

      // Cap individual impact
      const cappedImpact = Math.min(impact.pnlDelta, this.config.maxSingleImpact);
      totalScore += cappedImpact;
    }

    return totalScore;
  }

  /**
   * Normalize scores to sum to 1.
   */
  private normalizeScores(scores: Map<string, number>): Map<string, number> {
    const total = Array.from(scores.values()).reduce((a, b) => a + b, 0);
    
    if (total === 0) {
      return new Map(); // No impact this epoch
    }

    const normalized = new Map<string, number>();
    for (const [researcher, score] of scores) {
      normalized.set(researcher, score / total);
    }
    return normalized;
  }

  /**
   * Generate epoch summary for on-chain recording.
   */
  generateEpochSummary(
    epochId: number,
    impacts: ResearchImpact[],
    normalizedScores: Map<string, number>
  ): EpochSummary {
    const acceptedProposals = impacts.filter(i => i.accepted).length;
    const totalImpact = impacts
      .filter(i => i.accepted && i.pnlDelta > 0)
      .reduce((sum, i) => sum + i.pnlDelta, 0);

    return {
      epochId,
      startTimestamp: 0, // Set by caller
      endTimestamp: 0,   // Set by caller
      totalProposals: impacts.length,
      acceptedProposals,
      totalPositiveImpact: totalImpact,
      topResearchers: this.getTopResearchers(normalizedScores, 10),
    };
  }

  private getTopResearchers(
    scores: Map<string, number>,
    limit: number
  ): Array<{ researcher: string; score: number }> {
    return Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([researcher, score]) => ({ researcher, score }));
  }
}

