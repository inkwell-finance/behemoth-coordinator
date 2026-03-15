/**
 * Bridge between P2P network and coordinator logic.
 * Handles libp2p communication.
 */

import { ResearchProposal, JobAssignment, JobResult } from '@inkwell-finance/behemoth-protocol';
import logger from '../shared/logger.js';

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
    private onJobResult: (result: JobResult, peerId: string, traceId?: string) => Promise<void>,
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
        logger.error({ err: e }, 'Error handling proposal');
      }
    });

    // Listen for job results
    this.bridge.subscribe(P2P_TOPICS.RESULTS, async (msg, peerId) => {
      try {
        // Extract the job_result envelope which may carry a traceId
        const envelope = msg as { type?: string; result?: JobResult; traceId?: string };
        if (envelope.type === 'job_result' && envelope.result) {
          await this.onJobResult(envelope.result, peerId, envelope.traceId);
        } else {
          // Fallback: treat the whole message as a JobResult (backwards compat)
          await this.onJobResult(msg as JobResult, peerId);
        }
      } catch (e) {
        logger.error({ err: e }, 'Error handling result');
      }
    });
  }

  /**
   * Broadcast job assignments.
   */
  async broadcastJobAssignments(assignments: JobAssignment[], traceId?: string): Promise<void> {
    // Broadcast all assignments
    await this.bridge.publish(P2P_TOPICS.JOBS, {
      type: 'job_assignments',
      assignments,
      traceId,
      timestamp: Date.now(),
    });

    // Also send direct messages to assigned nodes
    for (const assignment of assignments) {
      try {
        await this.bridge.sendDirect(assignment.nodeId, {
          type: 'job_assigned',
          assignment,
          traceId,
        });
      } catch (e) {
        logger.error({ err: e, nodeId: assignment.nodeId }, 'Failed to send direct assignment');
      }
    }
  }

  /**
   * Broadcast proposal result.
   */
  async broadcastProposalResult(result: unknown, traceId?: string): Promise<void> {
    await this.bridge.publish(P2P_TOPICS.RESULTS, {
      type: 'proposal_result',
      result,
      traceId,
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

