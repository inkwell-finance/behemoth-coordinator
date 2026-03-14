/**
 * Bridge between P2P network and coordinator logic.
 * Handles libp2p communication.
 */

import { ResearchProposal, JobAssignment, JobResult } from '@inkwell-finance/protocol';

// Topics for P2P communication
export const P2P_TOPICS = {
  PROPOSALS: '/behemoth/proposals/1.0.0',
  JOBS: '/behemoth/jobs/1.0.0',
  RESULTS: '/behemoth/results/1.0.0',
  ANNOUNCEMENTS: '/behemoth/announcements/1.0.0',
} as const;

export interface P2PBridgeConfig {
  bootstrapPeers: string[];
  listenAddresses: string[];
  privateKey?: string;
}

/**
 * Interface for the P2P bridge.
 * Actual implementation uses libp2p.
 */
export interface P2PBridge {
  /**
   * Start the P2P node.
   */
  start(): Promise<void>;

  /**
   * Stop the P2P node.
   */
  stop(): Promise<void>;

  /**
   * Subscribe to a topic.
   */
  subscribe(topic: string, handler: (message: unknown, peerId: string) => void): void;

  /**
   * Publish to a topic.
   */
  publish(topic: string, message: unknown): Promise<void>;

  /**
   * Get connected peers.
   */
  getPeers(): string[];

  /**
   * Send direct message to a peer.
   */
  sendDirect(peerId: string, message: unknown): Promise<void>;
}

/**
 * Coordinator-side P2P message handlers.
 */
export class CoordinatorP2PHandler {
  constructor(
    private bridge: P2PBridge,
    private onProposal: (proposal: ResearchProposal, peerId: string) => Promise<void>,
    private onJobResult: (result: JobResult, peerId: string) => Promise<void>,
  ) {}

  /**
   * Initialize subscriptions.
   */
  init(): void {
    // Listen for proposals
    this.bridge.subscribe(P2P_TOPICS.PROPOSALS, async (msg, peerId) => {
      try {
        const proposal = msg as ResearchProposal;
        await this.onProposal(proposal, peerId);
      } catch (e) {
        console.error('Error handling proposal:', e);
      }
    });

    // Listen for job results
    this.bridge.subscribe(P2P_TOPICS.RESULTS, async (msg, peerId) => {
      try {
        const result = msg as JobResult;
        await this.onJobResult(result, peerId);
      } catch (e) {
        console.error('Error handling result:', e);
      }
    });
  }

  /**
   * Broadcast job assignments.
   */
  async broadcastJobAssignments(assignments: JobAssignment[]): Promise<void> {
    // Broadcast all assignments
    await this.bridge.publish(P2P_TOPICS.JOBS, {
      type: 'job_assignments',
      assignments,
      timestamp: Date.now(),
    });

    // Also send direct messages to assigned nodes
    for (const assignment of assignments) {
      try {
        await this.bridge.sendDirect(assignment.nodeId, {
          type: 'job_assigned',
          assignment,
        });
      } catch (e) {
        console.error(`Failed to send direct assignment to ${assignment.nodeId}:`, e);
      }
    }
  }

  /**
   * Broadcast proposal result.
   */
  async broadcastProposalResult(result: unknown): Promise<void> {
    await this.bridge.publish(P2P_TOPICS.RESULTS, {
      type: 'proposal_result',
      result,
      timestamp: Date.now(),
    });
  }

  /**
   * Broadcast announcement (schema updates, epoch changes, etc).
   */
  async broadcastAnnouncement(announcement: unknown): Promise<void> {
    await this.bridge.publish(P2P_TOPICS.ANNOUNCEMENTS, {
      type: 'announcement',
      announcement,
      timestamp: Date.now(),
    });
  }
}

