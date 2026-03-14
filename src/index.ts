/**
 * behemoth-coordinator - Research Gateway & Job Distribution
 *
 * This is the open-source coordinator that:
 * - Validates research proposals
 * - Distributes backtest jobs to compute nodes
 * - Injects noise into results (config is private)
 * - Bridges P2P network with the trader via gRPC
 */

// Export gateway components
export { ProposalValidator, type ProposalValidatorConfig } from './gateway/proposal-validator';
export { RateLimiter, type RateLimitConfig } from './gateway/rate-limiter';
export { PUBLIC_SLOT_SCHEMA, getSlotSchema, isValidSlot } from './gateway/slot-schema';

// Export job distribution
export { JobDistributor, type JobDistributorConfig } from './jobs/distributor';

// Export results processing
export { NoiseInjector, type NoiseConfig, type NoisedResult, type ProposalScore } from './results/noise-injector';
export { ImpactCalculator } from './results/impact-calculator';

// Export P2P bridge
export { type P2PBridge, type P2PBridgeConfig, CoordinatorP2PHandler, P2P_TOPICS } from './p2p/bridge';
export { createP2PBridge } from './p2p/node';

// Export trader client (gRPC)
export { type TraderClient, type TraderClientConfig, createTraderClient } from './trader/client';

// Export swarm coordination
export {
  SwarmCoordinator,
  type ResearcherInfo,
  type SwarmCycleState,
  type SwarmConfig,
} from './swarm';

// Re-export types from protocol
export type {
  ResearchProposal,
  ProposalResult,
  ValidationResult,
  BacktestJob,
  BacktestResult,
  BacktestRequest,
  BacktestResponse,
  PaperShadowRequest,
  PaperShadowResponse,
  SlotSchema,
  SlotDefinition,
  SlotModification,
  JobAssignment,
  JobResult,
  ComputeNode,
} from '@inkwell-finance/protocol';

// ============================================================================
// Server Entrypoint - Only runs when executed directly (not imported)
// ============================================================================

import { PUBLIC_SLOT_SCHEMA } from './gateway/slot-schema';
import { ProposalValidator } from './gateway/proposal-validator';
import { RateLimiter } from './gateway/rate-limiter';
import { createTraderClient } from './trader/client';
import { createP2PBridge } from './p2p/node';
import { P2P_TOPICS, CoordinatorP2PHandler, type P2PBridge } from './p2p/bridge';
import { JobDistributor } from './jobs/distributor';
import type { ResearchProposal, JobResult, ComputeNode, BacktestJob } from '@inkwell-finance/protocol';

// Check if running as main module (Node.js doesn't have import.meta.main)
const isMainModule = process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('index.ts');

if (isMainModule) {
  const httpPort = parseInt(process.env.HTTP_PORT || '8081', 10);
  const traderGrpcUrl = process.env.TRADER_GRPC_URL || 'localhost:50051';
  const p2pEnabled = process.env.P2P_ENABLED !== 'false';
  const libp2pAddresses = process.env.LIBP2P_LISTEN_ADDRESSES || '/ip4/0.0.0.0/tcp/4001';

  console.log(`[Coordinator] Starting behemoth-coordinator...`);
  console.log(`[Coordinator] HTTP port: ${httpPort}`);
  console.log(`[Coordinator] Trader gRPC: ${traderGrpcUrl}`);
  console.log(`[Coordinator] P2P enabled: ${p2pEnabled}`);

  // Initialize components
  const validator = new ProposalValidator({
    slotSchema: PUBLIC_SLOT_SCHEMA,
    maxModificationsPerProposal: 10,
  });

  const rateLimiter = new RateLimiter({
    maxPerDay: 10,
    maxPerQuarter: 200,
    cooldownMs: 30 * 60 * 1000, // 30 minutes
  });

  // Job distributor for assigning backtests to compute nodes
  const jobDistributor = new JobDistributor({
    redundancyFactor: 1, // Start with 1 node per job (increase when more nodes join)
    auditSampleRate: 0.05,
    jobTimeoutMs: 5 * 60 * 1000, // 5 minutes
    maxRetries: 2,
  });

  // Track connected compute nodes
  const computeNodes = new Map<string, ComputeNode>();

  const traderClient = createTraderClient({ endpoint: traderGrpcUrl, timeoutMs: 5000 });

  // P2P bridge (optional - may be null if disabled or failed to init)
  let p2pBridge: (P2PBridge & { peerId: string; getMultiaddrs(): string[] }) | null = null;
  let p2pHandler: CoordinatorP2PHandler | null = null;

  /**
   * Handle incoming research proposal from P2P network.
   */
  async function handleProposal(proposal: ResearchProposal, peerId: string): Promise<void> {
    console.log(`[Coordinator] Received proposal ${proposal.proposalId} from ${peerId}`);

    // Rate limit check
    const rateOk = rateLimiter.canSubmit(peerId);
    if (!rateOk.allowed) {
      console.log(`[Coordinator] Rate limited ${peerId}: ${rateOk.reason}`);
      return;
    }
    rateLimiter.recordSubmission(peerId);

    // Validate the proposal
    const validationResult = validator.validate(proposal);
    if (!validationResult.valid) {
      console.log(`[Coordinator] Proposal ${proposal.proposalId} invalid: ${validationResult.errors.join(', ')}`);
      // Broadcast rejection
      if (p2pHandler) {
        await p2pHandler.broadcastProposalResult({
          proposalId: proposal.proposalId,
          status: 'rejected',
          errors: validationResult.errors,
        });
      }
      return;
    }

    console.log(`[Coordinator] Proposal ${proposal.proposalId} validated successfully`);

    // Get available compute nodes
    const availableNodes = Array.from(computeNodes.values()).filter(n => n.isOnline && n.currentJobs < n.maxJobs);

    if (availableNodes.length === 0) {
      console.log(`[Coordinator] No compute nodes available for proposal ${proposal.proposalId}`);
      // For now, accept the proposal but mark as pending
      // In production, we'd queue this
      return;
    }

    try {
      // Create job and get assignments
      const assignments = jobDistributor.createJob(proposal.proposalId, availableNodes);
      console.log(`[Coordinator] Created job for proposal ${proposal.proposalId} with ${assignments.length} assignments`);

      // Broadcast job assignments
      if (p2pHandler) {
        await p2pHandler.broadcastJobAssignments(assignments);
      }

      // Also broadcast the actual backtest job details
      const backtestJob: BacktestJob = {
        jobId: assignments[0].jobId,
        proposalId: proposal.proposalId,
        modifications: proposal.modifications.map(m => ({ slotId: m.slotId, value: m.proposedValue })),
        dataRange: {
          start: Date.now() - 90 * 24 * 60 * 60 * 1000, // 90 days ago
          end: Date.now(),
        },
        assignedAt: Date.now(),
        timeoutAt: assignments[0].timeoutAt,
      };

      if (p2pBridge) {
        await p2pBridge.publish(P2P_TOPICS.JOBS, {
          type: 'backtest_job',
          job: backtestJob,
          timestamp: Date.now(),
        });
      }
    } catch (e) {
      console.error(`[Coordinator] Failed to create job for proposal ${proposal.proposalId}:`, e);
    }
  }

  /**
   * Handle incoming job result from P2P network.
   */
  async function handleJobResult(result: JobResult, peerId: string): Promise<void> {
    console.log(`[Coordinator] Received result for job ${result.jobId} from ${peerId}`);

    try {
      // Submit result to job distributor for consensus
      jobDistributor.submitResult(result.jobId, result.nodeId, {
        nodeId: result.nodeId,
        score: result.result.score,
        computeTimeMs: 0, // Not tracked in current JobResult type
        hash: result.result.hash,
      });

      // Broadcast the result
      if (p2pHandler) {
        await p2pHandler.broadcastProposalResult({
          proposalId: result.result.proposalId,
          status: 'completed',
          result: result.result,
        });
      }
    } catch (e) {
      console.error(`[Coordinator] Failed to process result for job ${result.jobId}:`, e);
    }
  }

  // Start P2P if enabled
  if (p2pEnabled) {
    (async () => {
      try {
        p2pBridge = await createP2PBridge({
          listenAddresses: libp2pAddresses.split(','),
          bootstrapPeers: [],
        });
        await p2pBridge.start();
        console.log(`[Coordinator] P2P bridge started with peer ID: ${p2pBridge.peerId}`);

        // Set up P2P handler with proposal and result callbacks
        p2pHandler = new CoordinatorP2PHandler(
          p2pBridge,
          handleProposal,
          handleJobResult,
        );
        p2pHandler.init();
        console.log(`[Coordinator] P2P handler initialized, listening for proposals and results`);

        // Register ourselves as a default compute node (for testing)
        // In production, nodes would announce themselves
        computeNodes.set(p2pBridge.peerId, {
          peerId: p2pBridge.peerId,
          publicKey: '',
          reputation: 1.0,
          currentJobs: 0,
          maxJobs: 5,
          isOnline: true,
          lastSeen: Date.now(),
        });
      } catch (e) {
        console.warn(`[Coordinator] P2P failed to start (non-fatal):`, e);
      }
    })();
  }

  // Start HTTP server using Node.js http module
  const http = await import('http');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${httpPort}`);

    const json = (data: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    // Health check
    if (url.pathname === '/health') {
      return json({ status: 'healthy', service: 'coordinator' });
    }

    // Status
    if (url.pathname === '/status') {
      return json({
        service: 'behemoth-coordinator',
        version: '1.0.0',
        uptime: process.uptime(),
        traderGrpcUrl,
        p2pEnabled,
        p2pPeerId: p2pBridge?.peerId ?? null,
      });
    }

    // Slots (both /slots and /api/slots)
    if (url.pathname === '/slots' || url.pathname === '/api/slots') {
      return json(PUBLIC_SLOT_SCHEMA);
    }

    // Helper to read request body
    const readBody = (): Promise<string> => {
      return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => resolve(body));
        req.on('error', reject);
      });
    };

    // Validate proposal (both /validate and /api/proposals/validate)
    if ((url.pathname === '/validate' || url.pathname === '/api/proposals/validate') && req.method === 'POST') {
      try {
        const bodyStr = await readBody();
        const body = JSON.parse(bodyStr);
        const result = validator.validate(body);
        return json(result);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Unknown error';
        return json({ valid: false, errors: [message] }, 400);
      }
    }

    // Submit proposal (requires auth)
    if (url.pathname === '/api/proposals' && req.method === 'POST') {
      // In production, verify signature and stake
      return json({ error: 'Unauthorized - signature required' }, 401);
    }

    // gRPC health check - calls trader via gRPC
    if (url.pathname === '/api/grpc/health') {
      try {
        const traderHealth = await traderClient.healthCheck();
        return json({
          grpcConnected: true,
          trader: traderHealth,
        });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Unknown error';
        return json({
          grpcConnected: false,
          error: message,
        }, 503);
      }
    }

    // P2P bridge status
    if (url.pathname === '/api/p2p/status') {
      return json({
        p2pEnabled,
        peerId: p2pBridge?.peerId ?? null,
        listenAddresses: p2pBridge?.getMultiaddrs() ?? libp2pAddresses.split(','),
        connectedPeers: p2pBridge?.getPeers().length ?? 0,
        peers: p2pBridge?.getPeers() ?? [],
        topics: Object.values(P2P_TOPICS),
      });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.listen(httpPort, () => {
    console.log(`[Coordinator] HTTP server listening on port ${httpPort}`);
    console.log(`[Coordinator] Ready to accept connections`);
  });
}

