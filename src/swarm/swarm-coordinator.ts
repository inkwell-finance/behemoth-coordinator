/**
 * SwarmCoordinator — Manages multiple research agents from the Coordinator side.
 * 
 * Responsibilities:
 *   - Track active researcher agents in the P2P network
 *   - Aggregate proposals from multiple agents per cycle
 *   - Coordinate evaluation timing (batch proposals for efficiency)
 *   - Emit events for strategy lifecycle transitions
 *   - Maintain swarm health metrics
 */

import { EventEmitter } from 'events';
import type { ResearchProposal, JobResult } from '@inkwell-finance/protocol';

export interface ResearcherInfo {
  peerId: string;
  publicKey: string;
  proposalsThisCycle: number;
  totalProposals: number;
  acceptedProposals: number;
  rejectedProposals: number;
  lastSeen: number;
  reputation: number;          // 0..1, starts at 0.5
  agentType?: string;          // 'genetic', 'rl_guided', 'random', 'crossover'
}

export interface SwarmCycleState {
  cycleId: string;
  startedAt: number;
  proposals: Map<string, ResearchProposal>; // proposalId → proposal
  results: Map<string, JobResult>;          // proposalId → result
  phase: 'collecting' | 'evaluating' | 'promoting' | 'complete';
}

export interface SwarmConfig {
  maxProposalsPerCycle: number;           // Max proposals to evaluate per cycle
  cycleTimeoutMs: number;                 // Max time to collect proposals
  minResearchersForQuorum: number;        // Min researchers needed to start cycle
  reputationDecayRate: number;            // Decay factor per rejected proposal
  reputationBoostRate: number;            // Boost factor per accepted proposal
}

const DEFAULT_CONFIG: SwarmConfig = {
  maxProposalsPerCycle: 20,
  cycleTimeoutMs: 5 * 60 * 1000,          // 5 minutes
  minResearchersForQuorum: 1,             // Start with 1 for initial testing
  reputationDecayRate: 0.05,
  reputationBoostRate: 0.1,
};

export class SwarmCoordinator extends EventEmitter {
  private readonly researchers = new Map<string, ResearcherInfo>();
  private currentCycle: SwarmCycleState | null = null;
  private cycleTimer?: ReturnType<typeof setTimeout>;
  private totalCycles = 0;

  constructor(private readonly config: SwarmConfig = DEFAULT_CONFIG) {
    super();
  }

  // -------------------------------------------------------------------------
  // Researcher management
  // -------------------------------------------------------------------------

  /**
   * Register or update a researcher agent.
   */
  registerResearcher(peerId: string, publicKey: string, agentType?: string): void {
    const existing = this.researchers.get(peerId);
    
    if (existing) {
      existing.lastSeen = Date.now();
      existing.agentType = agentType ?? existing.agentType;
    } else {
      this.researchers.set(peerId, {
        peerId,
        publicKey,
        proposalsThisCycle: 0,
        totalProposals: 0,
        acceptedProposals: 0,
        rejectedProposals: 0,
        lastSeen: Date.now(),
        reputation: 0.5,
        agentType,
      });
      console.log(`[SwarmCoordinator] Researcher registered: ${peerId} (${agentType ?? 'unknown'})`);
      this.emit('researcher-joined', { peerId, agentType });
    }

    this._checkQuorumAndStart();
  }

  /**
   * Mark a researcher as offline (called when P2P connection drops).
   */
  removeResearcher(peerId: string): void {
    if (this.researchers.delete(peerId)) {
      console.log(`[SwarmCoordinator] Researcher removed: ${peerId}`);
      this.emit('researcher-left', { peerId });
    }
  }

  /**
   * Get all active researchers.
   */
  getResearchers(): ResearcherInfo[] {
    return Array.from(this.researchers.values());
  }

  // -------------------------------------------------------------------------
  // Proposal handling
  // -------------------------------------------------------------------------

  /**
   * Handle incoming proposal from a researcher.
   */
  handleProposal(proposal: ResearchProposal, peerId: string): boolean {
    const researcher = this.researchers.get(peerId);
    if (!researcher) {
      console.warn(`[SwarmCoordinator] Proposal from unknown researcher: ${peerId}`);
      return false;
    }

    // Update researcher stats
    researcher.lastSeen = Date.now();
    researcher.totalProposals++;
    researcher.proposalsThisCycle++;

    // Ensure we have an active cycle
    if (!this.currentCycle) {
      this._startNewCycle();
    }

    // Check if cycle is still collecting
    if (this.currentCycle!.phase !== 'collecting') {
      console.log(`[SwarmCoordinator] Proposal rejected - cycle in ${this.currentCycle!.phase} phase`);
      return false;
    }

    // Check capacity
    if (this.currentCycle!.proposals.size >= this.config.maxProposalsPerCycle) {
      console.log(`[SwarmCoordinator] Proposal rejected - cycle full`);
      return false;
    }

    // Store proposal
    this.currentCycle!.proposals.set(proposal.proposalId, proposal);
    console.log(`[SwarmCoordinator] Proposal ${proposal.proposalId} accepted from ${peerId}`);
    this.emit('proposal-received', { proposal, peerId, cycleId: this.currentCycle!.cycleId });

    return true;
  }

  /**
   * Handle result from evaluation.
   */
  handleResult(proposalId: string, result: JobResult, accepted: boolean): void {
    if (!this.currentCycle) return;

    this.currentCycle.results.set(proposalId, result);

    // Update researcher reputation
    const proposal = this.currentCycle.proposals.get(proposalId);
    if (proposal) {
      const researcher = this.researchers.get(proposal.researcher);
      if (researcher) {
        if (accepted) {
          researcher.acceptedProposals++;
          researcher.reputation = Math.min(1, researcher.reputation + this.config.reputationBoostRate);
        } else {
          researcher.rejectedProposals++;
          researcher.reputation = Math.max(0, researcher.reputation - this.config.reputationDecayRate);
        }
      }
    }

    this.emit('result-processed', { proposalId, accepted });
  }

  // -------------------------------------------------------------------------
  // Cycle management
  // -------------------------------------------------------------------------

  /**
   * Get current cycle state.
   */
  getCurrentCycle(): SwarmCycleState | null {
    return this.currentCycle;
  }

  /**
   * Force start a new cycle (for testing or manual trigger).
   */
  forceStartCycle(): string {
    return this._startNewCycle();
  }

  /**
   * End the current cycle and transition to evaluation.
   */
  endCollectionPhase(): void {
    if (!this.currentCycle || this.currentCycle.phase !== 'collecting') return;

    this.currentCycle.phase = 'evaluating';
    if (this.cycleTimer) {
      clearTimeout(this.cycleTimer);
      this.cycleTimer = undefined;
    }

    console.log(`[SwarmCoordinator] Cycle ${this.currentCycle.cycleId} entering evaluation phase (${this.currentCycle.proposals.size} proposals)`);
    this.emit('cycle-evaluating', {
      cycleId: this.currentCycle.cycleId,
      proposalCount: this.currentCycle.proposals.size,
    });
  }

  /**
   * Complete the current cycle.
   */
  completeCycle(): void {
    if (!this.currentCycle) return;

    this.currentCycle.phase = 'complete';
    this.totalCycles++;

    const stats = {
      cycleId: this.currentCycle.cycleId,
      proposalsReceived: this.currentCycle.proposals.size,
      resultsProcessed: this.currentCycle.results.size,
      duration: Date.now() - this.currentCycle.startedAt,
    };

    console.log(`[SwarmCoordinator] Cycle ${this.currentCycle.cycleId} complete`, stats);
    this.emit('cycle-complete', stats);

    // Reset per-cycle counters
    for (const researcher of this.researchers.values()) {
      researcher.proposalsThisCycle = 0;
    }

    this.currentCycle = null;
  }

  /**
   * Get swarm statistics.
   */
  getStats(): {
    totalCycles: number;
    activeResearchers: number;
    currentCyclePhase: string | null;
    currentCycleProposals: number;
  } {
    return {
      totalCycles: this.totalCycles,
      activeResearchers: this.researchers.size,
      currentCyclePhase: this.currentCycle?.phase ?? null,
      currentCycleProposals: this.currentCycle?.proposals.size ?? 0,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _startNewCycle(): string {
    const cycleId = `swarm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    this.currentCycle = {
      cycleId,
      startedAt: Date.now(),
      proposals: new Map(),
      results: new Map(),
      phase: 'collecting',
    };

    // Set timeout to end collection phase
    this.cycleTimer = setTimeout(() => {
      this.endCollectionPhase();
    }, this.config.cycleTimeoutMs);

    console.log(`[SwarmCoordinator] New cycle started: ${cycleId}`);
    this.emit('cycle-started', { cycleId });

    return cycleId;
  }

  private _checkQuorumAndStart(): void {
    if (this.currentCycle) return; // Already have a cycle

    if (this.researchers.size >= this.config.minResearchersForQuorum) {
      this._startNewCycle();
    }
  }
}

