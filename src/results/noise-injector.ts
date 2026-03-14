/**
 * Injects noise into results to prevent gradient extraction.
 * 
 * The CODE is open source (so people know noise exists).
 * The PARAMETERS are private (so they can't compensate).
 */

export interface NoiseConfig {
  // All values loaded from PRIVATE config
  scoreVariancePercent: number;    // e.g., 5 (±5%)
  falseRejectionRate: number;      // e.g., 0.05 (5% of valid proposals rejected)
  feedbackTemplates: string[];     // Randomized feedback messages
  templateRandomizationRate: number; // e.g., 0.3 (30% get random feedback)
}

export interface ProposalScore {
  proposalId: string;
  relativeScore: number;
  percentileRank: number;
  isValid: boolean;
}

export interface NoisedResult {
  proposalId: string;
  relativeScore: number | null;
  rank: number | null;
  feedback: string;
  status: 'accepted' | 'rejected' | 'pending_paper';
  
  // Flag for internal tracking (not exposed)
  _wasFalseRejection?: boolean;
}

export class NoiseInjector {
  constructor(private config: NoiseConfig) {}

  /**
   * Apply noise to a proposal score.
   * This is the core defense against gradient extraction.
   */
  injectNoise(score: ProposalScore): NoisedResult {
    // Decide if this should be a false rejection
    if (score.isValid && Math.random() < this.config.falseRejectionRate) {
      return {
        proposalId: score.proposalId,
        relativeScore: null,
        rank: null,
        feedback: this.getRandomFeedback('rejected'),
        status: 'rejected',
        _wasFalseRejection: true,
      };
    }

    // Add variance to the score
    const noisedScore = this.addVariance(score.relativeScore);

    // Possibly use random feedback
    const useRandomFeedback = Math.random() < this.config.templateRandomizationRate;
    const feedback = useRandomFeedback
      ? this.getRandomFeedback('generic')
      : this.generateFeedback(noisedScore);

    return {
      proposalId: score.proposalId,
      relativeScore: noisedScore,
      rank: score.percentileRank,
      feedback,
      status: this.determineStatus(noisedScore),
    };
  }

  /**
   * Add variance to a score.
   * The exact variance is private.
   */
  private addVariance(score: number): number {
    const varianceFraction = this.config.scoreVariancePercent / 100;
    const maxVariance = Math.abs(score) * varianceFraction;
    const variance = (Math.random() * 2 - 1) * maxVariance;
    return score + variance;
  }

  /**
   * Get random feedback from templates.
   */
  private getRandomFeedback(type: 'rejected' | 'generic'): string {
    const templates = this.config.feedbackTemplates.filter(t => 
      type === 'rejected' ? t.includes('reject') : !t.includes('reject')
    );
    return templates[Math.floor(Math.random() * templates.length)] || 'Evaluation complete.';
  }

  /**
   * Generate feedback based on score.
   */
  private generateFeedback(score: number): string {
    if (score > 0.05) {
      return 'Proposal shows potential improvement in backtesting.';
    } else if (score > 0) {
      return 'Marginal improvement detected.';
    } else if (score > -0.02) {
      return 'Performance neutral within noise threshold.';
    } else {
      return 'Performance below baseline.';
    }
  }

  /**
   * Determine proposal status based on noised score.
   */
  private determineStatus(score: number): 'accepted' | 'rejected' | 'pending_paper' {
    // Thresholds could also be configurable
    if (score > 0.03) {
      return 'pending_paper'; // Good enough to paper trade
    } else if (score > -0.01) {
      return 'accepted'; // Recorded but not paper traded
    } else {
      return 'rejected';
    }
  }
}

