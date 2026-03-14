/**
 * Rate limiting for research proposals.
 * Prevents exploration attacks.
 */

export interface RateLimitConfig {
  // These values loaded from PRIVATE config
  maxPerDay: number;        // e.g., 3
  maxPerQuarter: number;    // e.g., 150
  cooldownMs: number;       // e.g., 3600000 (1 hour)
}

interface ResearcherUsage {
  dailyCount: number;
  quarterlyCount: number;
  lastSubmission: number;
  dayStart: number;
  quarterStart: number;
}

export class RateLimiter {
  private usage: Map<string, ResearcherUsage> = new Map();
  private getNow: () => number;

  constructor(private config: RateLimitConfig, getNow?: () => number) {
    this.getNow = getNow || (() => Date.now());
  }

  /**
   * Check if researcher can submit a proposal.
   */
  canSubmit(researcher: string): { allowed: boolean; reason?: string; retryAfter?: number } {
    const now = this.getNow();
    const usage = this.getOrCreateUsage(researcher, now);

    // Check cooldown
    const timeSinceLastSubmission = now - usage.lastSubmission;
    if (timeSinceLastSubmission < this.config.cooldownMs) {
      return {
        allowed: false,
        reason: 'Cooldown period active',
        retryAfter: this.config.cooldownMs - timeSinceLastSubmission,
      };
    }

    // Check daily limit
    if (usage.dailyCount >= this.config.maxPerDay) {
      const dayEnd = usage.dayStart + 24 * 60 * 60 * 1000;
      return {
        allowed: false,
        reason: 'Daily limit reached',
        retryAfter: dayEnd - now,
      };
    }

    // Check quarterly limit
    if (usage.quarterlyCount >= this.config.maxPerQuarter) {
      const quarterEnd = usage.quarterStart + 90 * 24 * 60 * 60 * 1000;
      return {
        allowed: false,
        reason: 'Quarterly limit reached',
        retryAfter: quarterEnd - now,
      };
    }

    return { allowed: true };
  }

  /**
   * Record a submission.
   */
  recordSubmission(researcher: string): void {
    const now = this.getNow();
    const usage = this.getOrCreateUsage(researcher, now);
    
    usage.dailyCount++;
    usage.quarterlyCount++;
    usage.lastSubmission = now;
    
    this.usage.set(researcher, usage);
  }

  private getOrCreateUsage(researcher: string, now: number): ResearcherUsage {
    let usage = this.usage.get(researcher);
    
    if (!usage) {
      usage = {
        dailyCount: 0,
        quarterlyCount: 0,
        lastSubmission: 0,
        dayStart: this.getDayStart(now),
        quarterStart: this.getQuarterStart(now),
      };
    }

    // Reset daily counter if new day
    const currentDayStart = this.getDayStart(now);
    if (currentDayStart > usage.dayStart) {
      usage.dailyCount = 0;
      usage.dayStart = currentDayStart;
    }

    // Reset quarterly counter if new quarter
    const currentQuarterStart = this.getQuarterStart(now);
    if (currentQuarterStart > usage.quarterStart) {
      usage.quarterlyCount = 0;
      usage.quarterStart = currentQuarterStart;
    }

    return usage;
  }

  private getDayStart(timestamp: number): number {
    const date = new Date(timestamp);
    date.setUTCHours(0, 0, 0, 0);
    return date.getTime();
  }

  private getQuarterStart(timestamp: number): number {
    const date = new Date(timestamp);
    const quarter = Math.floor(date.getUTCMonth() / 3);
    date.setUTCMonth(quarter * 3, 1);
    date.setUTCHours(0, 0, 0, 0);
    return date.getTime();
  }
}

