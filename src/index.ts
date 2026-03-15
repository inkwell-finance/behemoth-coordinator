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
export { RateLimiter, type RateLimitConfig, type RateTier, DEFAULT_TIER, SILVER_TIER, GOLD_TIER, getTierForResearcher, isValidResearcherPubkey } from './gateway/rate-limiter';
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

// Export metrics
export {
  register,
  proposalsReceivedTotal,
  jobsCreatedTotal,
  jobsFinalizedTotal,
  resultsReceivedTotal,
  pendingJobsCount,
  connectedPeersCount,
  connectedComputeNodesCount,
  proposalValidationDuration,
  grpcCallDuration,
  proposalQueueRejectionsTotal,
  duplicateNonceRejectionsTotal,
  failedBroadcastsTotal,
} from './metrics';

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
} from '@inkwell-finance/behemoth-protocol';

// ============================================================================
// Server Entrypoint - Only runs when executed directly (not imported)
// ============================================================================

import { PUBLIC_SLOT_SCHEMA } from './gateway/slot-schema';
import { ProposalValidator } from './gateway/proposal-validator';
import { RateLimiter, isValidResearcherPubkey } from './gateway/rate-limiter';
import { createTraderClient } from './trader/client';
import { createP2PBridge } from './p2p/node';
import { P2P_TOPICS, CoordinatorP2PHandler, type P2PBridge } from './p2p/bridge';
import { JobDistributor } from './jobs/distributor';
import { NoiseInjector } from './results/noise-injector';
import { ImpactCalculator } from './results/impact-calculator';
import { SwarmCoordinator } from './swarm/swarm-coordinator';
import { closeRedisClient, getRedisClient, waitForRedis } from './shared/redis';
import logger from './shared/logger';
import {
  register,
  proposalsReceivedTotal,
  jobsCreatedTotal,
  jobsFinalizedTotal,
  resultsReceivedTotal,
  pendingJobsCount,
  connectedPeersCount,
  connectedComputeNodesCount,
  proposalValidationDuration,
  grpcCallDuration,
} from './metrics';
import type { ResearchProposal, JobResult, ComputeNode, BacktestJob, ResearchImpact } from '@inkwell-finance/behemoth-protocol';

// Check if running as main module (Node.js doesn't have import.meta.main)
const isMainModule = process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('index.ts');

if (isMainModule) {
  const httpPort = parseInt(process.env.HTTP_PORT || '8081', 10);
  const traderGrpcUrl = process.env.TRADER_GRPC_URL || 'localhost:50051';
  const p2pEnabled = process.env.P2P_ENABLED !== 'false';
  const libp2pAddresses = process.env.LIBP2P_LISTEN_ADDRESSES || '/ip4/0.0.0.0/tcp/4001';

  logger.info({ httpPort, traderGrpcUrl, p2pEnabled }, 'Starting behemoth-coordinator');

  // Wait for Redis to be available before initializing Redis-dependent components
  try {
    await waitForRedis();
  } catch (err) {
    logger.error({ err }, 'Failed to connect to Redis');
    process.exit(1);
  }

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
  // Load persisted jobs from Redis and start the timeout sweep
  await jobDistributor.init();

  // Noise injection — scale sourced from NOISE_SCALE env var (default 0.01 = 1%)
  const noiseScale = parseFloat(process.env.NOISE_SCALE || '0.01');
  const noiseInjector = new NoiseInjector({
    scoreVariancePercent: noiseScale * 100,
    falseRejectionRate: 0.0,
    feedbackTemplates: [
      'Evaluation complete.',
      'Performance evaluated against baseline.',
      'Proposal scored and recorded.',
    ],
    templateRandomizationRate: 0.0,
  });
  logger.info({ scoreVariancePercent: noiseScale * 100 }, 'NoiseInjector ready');

  // Swarm coordinator — tracks researcher agents and manages reputation
  const swarmCoordinator = new SwarmCoordinator();
  await swarmCoordinator.init();
  logger.info('SwarmCoordinator ready');

  // Impact calculator — scores researcher contributions per epoch
  const impactCalculator = new ImpactCalculator({
    maxSingleImpact: 0.1,
    paperTradeDaysRequired: 7,
  });
  const redisClient = getRedisClient();
  // In-memory accumulator for the running epoch impacts
  const epochImpacts: ResearchImpact[] = [];
  // Reload persisted impacts for the current epoch from Redis
  const startupEpoch = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const storedImpacts = await redisClient.lrange(`epoch:${startupEpoch}:impacts`, 0, -1);
  epochImpacts.push(...storedImpacts.map((s: string) => JSON.parse(s) as ResearchImpact));
  logger.info({ count: epochImpacts.length, epoch: startupEpoch }, 'Reloaded epoch impacts from Redis');
  let lastEpoch = startupEpoch;
  logger.info('ImpactCalculator ready');

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
    const traceId = proposal.traceId ?? crypto.randomUUID();
    logger.info({ traceId, proposalId: proposal.proposalId, peerId }, 'Received proposal');
    proposalsReceivedTotal.labels('received').inc();

    // Derive rate-limit key from researcher pubkey (preferred) or fall back to
    // peerId.  Proposals without a valid pubkey are still processed but keyed
    // by peerId so they can't bypass limits by omitting the field.
    const researcher = proposal.researcher;
    const rateLimitKey = isValidResearcherPubkey(researcher ?? '')
      ? researcher
      : (() => {
          logger.warn({ proposalId: proposal.proposalId, peerId }, 'Proposal has missing/invalid researcher pubkey; falling back to peerId for rate limiting');
          return peerId;
        })();

    // Rate limit check
    const rateOk = await rateLimiter.canSubmit(rateLimitKey);
    if (!rateOk.allowed) {
      logger.info({ rateLimitKey, reason: rateOk.reason }, 'Proposal rate limited');
      proposalsReceivedTotal.labels('rate_limited').inc();
      return;
    }
    await rateLimiter.recordSubmission(rateLimitKey);

    // Validate the proposal with timing
    const validationStartTime = Date.now();
    const validationResult = await validator.validate(proposal);
    const validationDuration = (Date.now() - validationStartTime) / 1000;
    proposalValidationDuration.observe(validationDuration);

    if (!validationResult.valid) {
      logger.info({ proposalId: proposal.proposalId, errors: validationResult.errors }, 'Proposal invalid');
      proposalsReceivedTotal.labels('invalid').inc();
      // Broadcast rejection with timeout
      if (p2pHandler) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10_000);
        try {
          await Promise.race([
            p2pHandler.broadcastProposalResult({
              proposalId: proposal.proposalId,
              status: 'rejected',
              errors: validationResult.errors,
            }, traceId),
            new Promise((_, reject) => {
              controller.signal.addEventListener('abort', () => {
                reject(new Error('Broadcast timeout'));
              });
            }),
          ]);
        } catch (err) {
          logger.warn({ err }, 'Failed to broadcast proposal rejection');
        } finally {
          clearTimeout(timeoutId);
        }
      }
      return;
    }

    proposalsReceivedTotal.labels('valid').inc();
    logger.info({ proposalId: proposal.proposalId }, 'Proposal validated successfully');

    // Register researcher in swarm on first valid proposal submission
    swarmCoordinator.registerResearcher(peerId, proposal.researcher ?? peerId);

    // Get available compute nodes
    const availableNodes = Array.from(computeNodes.values()).filter(n => n.isOnline && n.currentJobs < n.maxJobs);

    if (availableNodes.length === 0) {
      logger.info({ proposalId: proposal.proposalId }, 'No compute nodes available, enqueueing for retry');
      const queueResult = await jobDistributor.enqueueProposal(proposal);
      if (queueResult === 'rejected') {
        logger.warn({ proposalId: proposal.proposalId }, 'Failed to enqueue proposal: queue full');
        proposalsReceivedTotal.labels('dropped').inc();
        return;
      }
      proposalsReceivedTotal.labels('pending').inc();
      return;
    }

    try {
      // Create job and get assignments
      const assignments = await jobDistributor.createJob(proposal.proposalId, availableNodes);
      jobsCreatedTotal.inc();
      pendingJobsCount.inc();
      logger.info({ traceId, proposalId: proposal.proposalId, assignmentCount: assignments.length }, 'Created job for proposal');

      // Broadcast job assignments with timeout
      if (p2pHandler) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10_000);
        try {
          await Promise.race([
            p2pHandler.broadcastJobAssignments(assignments, traceId),
            new Promise((_, reject) => {
              controller.signal.addEventListener('abort', () => {
                reject(new Error('Broadcast timeout'));
              });
            }),
          ]);
        } catch (err) {
          logger.warn({ err }, 'Failed to broadcast job assignments');
        } finally {
          clearTimeout(timeoutId);
        }
      }

      // Also broadcast the actual backtest job details with timeout
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
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10_000);
        try {
          await Promise.race([
            p2pBridge.publish(P2P_TOPICS.JOBS, {
              type: 'backtest_job',
              job: backtestJob,
              traceId,
              timestamp: Date.now(),
            }),
            new Promise((_, reject) => {
              controller.signal.addEventListener('abort', () => {
                reject(new Error('Broadcast timeout'));
              });
            }),
          ]);
        } catch (err) {
          logger.warn({ err }, 'Failed to broadcast backtest job');
        } finally {
          clearTimeout(timeoutId);
        }
      }
    } catch (err) {
      logger.error('createJob failed', { proposalId: proposal.proposalId, error: err });
      const retryCount = ((proposal as ResearchProposal & { retryCount?: number }).retryCount || 0) + 1;
      if (retryCount < 3) {
        await jobDistributor.enqueueProposal({ ...proposal, retryCount } as ResearchProposal);
        logger.info('Re-queued proposal for retry', { proposalId: proposal.proposalId, retryCount });
      } else {
        logger.error('Proposal exhausted retries, dropping', { proposalId: proposal.proposalId });
      }
    }
  }

  /**
   * Handle incoming job result from P2P network.
   */
  async function handleJobResult(result: JobResult, peerId: string, traceId?: string): Promise<void> {
    logger.info({ jobId: result.jobId, peerId, traceId }, 'Received result for job');
    resultsReceivedTotal.labels(result.nodeId).inc();

    try {
      // Submit result to job distributor for consensus
      const finalized = await jobDistributor.submitResult(result.jobId, result.nodeId, {
        nodeId: result.nodeId,
        score: result.result.score,
        computeTimeMs: 0, // Not tracked in current JobResult type
        hash: result.result.hash,
      });

      // Record job finalization only when this submission actually finalizes the job
      if (finalized) {
        pendingJobsCount.dec();
        jobsFinalizedTotal.labels('consensus').inc();
      }

      // Detect epoch rollover (midnight boundary) and clear stale in-memory impacts
      const currentEpoch = new Date().toISOString().slice(0, 10);
      if (currentEpoch !== lastEpoch) {
        epochImpacts.length = 0;
        lastEpoch = currentEpoch;
        // Reload from Redis for the new epoch if any impacts were already persisted
        const stored = await redisClient.lrange(`epoch:${currentEpoch}:impacts`, 0, -1);
        epochImpacts.push(...stored.map((s: string) => JSON.parse(s) as ResearchImpact));
        logger.info({ epoch: currentEpoch, reloadedCount: epochImpacts.length }, 'Epoch rolled over; reloaded impacts from Redis');
      }

      // Apply noise to the result score before broadcasting to researchers
      const sortedScores = epochImpacts.map(i => i.pnlDelta).sort((a, b) => a - b);
      const belowCount = sortedScores.filter(s => s < result.result.score).length;
      const percentileRank = sortedScores.length > 1
        ? belowCount / (sortedScores.length - 1)
        : 0.5;
      const proposalScore = {
        proposalId: result.result.proposalId,
        relativeScore: result.result.score,
        percentileRank,
        isValid: true,
      };
      const noisedResult = noiseInjector.injectNoise(proposalScore);
      const accepted = noisedResult.status !== 'rejected';

      // Update swarm coordinator with result and reputation
      swarmCoordinator.handleResult(result.result.proposalId, result, accepted);

      // Calculate impact and persist to Redis
      const impactEntry: ResearchImpact = {
        proposalId: result.result.proposalId,
        researcher: swarmCoordinator.getProposalResearcher(result.result.proposalId) ?? peerId,
        accepted,
        pnlDelta: accepted ? result.result.score : 0,
        paperTradeDays: 0,
        evaluatedAt: Date.now(),
      };
      epochImpacts.push(impactEntry);
      const epochImpactsKey = `epoch:${currentEpoch}:impacts`;
      await redisClient.rpush(epochImpactsKey, JSON.stringify(impactEntry));
      await redisClient.expire(epochImpactsKey, 7 * 24 * 60 * 60); // TTL: 7 days
      const impactScores = impactCalculator.calculateEpochImpacts(epochImpacts);
      const impactKey = `coordinator:impact:${result.result.proposalId}`;
      await redisClient.set(impactKey, JSON.stringify({ score: noisedResult.relativeScore, accepted, calculatedAt: Date.now() }));
      logger.info({ proposalId: result.result.proposalId, score: noisedResult.relativeScore, accepted, epochResearchers: impactScores.size, traceId }, 'Impact calculated for proposal');

      // Broadcast the noised result to researchers
      if (p2pHandler) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10_000);
        try {
          await Promise.race([
            p2pHandler.broadcastProposalResult({
              proposalId: result.result.proposalId,
              status: noisedResult.status === 'rejected' ? 'rejected' : 'completed',
              result: { ...result.result, score: noisedResult.relativeScore ?? result.result.score },
            }, traceId),
            new Promise((_, reject) => {
              controller.signal.addEventListener('abort', () => {
                reject(new Error('Broadcast timeout'));
              });
            }),
          ]);
        } catch (err) {
          logger.warn({ err }, 'Failed to broadcast proposal result');
        } finally {
          clearTimeout(timeoutId);
        }
      }
    } catch (e) {
      logger.error({ err: e, jobId: result.jobId }, 'Failed to process result for job');
    }
  }


  /**
   * Process queued proposals — try to schedule them if nodes are now available.
   * Run periodically (every 30s) by the queue sweep timer.
   */
  async function processQueuedProposals(): Promise<void> {
    const availableNodes = Array.from(computeNodes.values()).filter(n => n.isOnline && n.currentJobs < n.maxJobs);

    if (availableNodes.length === 0) {
      return; // Still no nodes available
    }

    // Atomically dequeue the next proposal (returns null if queue is empty)
    const queuedProposal = await jobDistributor.dequeueNextProposal();
    if (!queuedProposal) {
      return; // No queued proposals
    }

    // Use existing traceId from proposal or generate one for this dequeue attempt
    const queuedTraceId = queuedProposal.traceId ?? crypto.randomUUID();

    // Try to create a job for this queued proposal
    try {
      const assignments = await jobDistributor.createJob(queuedProposal.proposalId, availableNodes);
      jobsCreatedTotal.inc();
      pendingJobsCount.inc();
      logger.info({ proposalId: queuedProposal.proposalId, assignmentCount: assignments.length }, 'Created job for queued proposal');

      // Broadcast job assignments
      if (p2pHandler) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10_000);
        try {
          await Promise.race([
            p2pHandler.broadcastJobAssignments(assignments, queuedTraceId),
            new Promise((_, reject) => {
              controller.signal.addEventListener('abort', () => {
                reject(new Error('Broadcast timeout'));
              });
            }),
          ]);
        } catch (err) {
          logger.warn({ err }, 'Failed to broadcast queued job assignments');
        } finally {
          clearTimeout(timeoutId);
        }
      }

      // Also broadcast the backtest job details
      const backtestJob: BacktestJob = {
        jobId: assignments[0].jobId,
        proposalId: queuedProposal.proposalId,
        modifications: queuedProposal.modifications.map(m => ({ slotId: m.slotId, value: m.proposedValue })),
        dataRange: {
          start: Date.now() - 90 * 24 * 60 * 60 * 1000, // 90 days ago
          end: Date.now(),
        },
        assignedAt: Date.now(),
        timeoutAt: assignments[0].timeoutAt,
      };

      if (p2pBridge) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10_000);
        try {
          await Promise.race([
            p2pBridge.publish(P2P_TOPICS.JOBS, {
              type: 'backtest_job',
              job: backtestJob,
              traceId: queuedTraceId,
              timestamp: Date.now(),
            }),
            new Promise((_, reject) => {
              controller.signal.addEventListener('abort', () => {
                reject(new Error('Broadcast timeout'));
              });
            }),
          ]);
        } catch (err) {
          logger.warn({ err }, 'Failed to publish queued backtest job');
        } finally {
          clearTimeout(timeoutId);
        }
      }
    } catch (e) {
      logger.error({ err: e, proposalId: queuedProposal.proposalId }, 'Failed to create job for queued proposal');
    }
  }

  // Start periodic processing of queued proposals (every 30s)
  setInterval(() => {
    processQueuedProposals().catch(err =>
      logger.error({ err }, 'Error processing queued proposals'),
    );
  }, 30_000);
  // Start P2P if enabled
  if (p2pEnabled) {
    (async () => {
      try {
        p2pBridge = await createP2PBridge({
          listenAddresses: libp2pAddresses.split(','),
          bootstrapPeers: [],
        });
        await p2pBridge.start();
        logger.info({ peerId: p2pBridge.peerId }, 'P2P bridge started');

        // Set up P2P handler with proposal and result callbacks
        p2pHandler = new CoordinatorP2PHandler(
          p2pBridge,
          handleProposal,
          handleJobResult,
        );
        p2pHandler.init();
        logger.info('P2P handler initialized, listening for proposals and results');

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

        // Update connected peers count
        connectedPeersCount.set(p2pBridge.getPeers().length);
        connectedComputeNodesCount.set(computeNodes.size);
      } catch (e) {
        logger.warn({ err: e }, 'P2P failed to start (non-fatal)');
      }
    })();
  }

  // Start HTTP server using Node.js http module
  const http = await import('http');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${httpPort}`);

    // Add security headers early to all responses
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Cache-Control', 'no-store');

    const json = (data: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    // Health check
    if (url.pathname === '/health') {
      return json({ status: 'healthy', service: 'coordinator' });
    }

    // Prometheus metrics endpoint
    if (url.pathname === '/metrics') {
      // Update dynamic gauges
      connectedPeersCount.set(p2pBridge?.getPeers().length ?? 0);
      connectedComputeNodesCount.set(computeNodes.size);

      res.writeHead(200, { 'Content-Type': register.contentType });
      res.end(await register.metrics());
      return;
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

    // Helper to read request body with size limit and timeout
    const readBody = (): Promise<string> => {
      return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => {
          controller.abort();
          reject(new Error('Request body read timeout'));
        }, 10000); // 10 second timeout

        let body = '';
        let size = 0;
        const MAX_SIZE = 1_048_576; // 1MB

        req.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_SIZE) {
            clearTimeout(timeout);
            reject(new Error('Payload too large'));
            return;
          }
          body += chunk.toString();
        });

        req.on('end', () => {
          clearTimeout(timeout);
          resolve(body);
        });

        req.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
    };

    // Validate proposal (both /validate and /api/proposals/validate)
    if ((url.pathname === '/validate' || url.pathname === '/api/proposals/validate') && req.method === 'POST') {
      const contentType = req.headers['content-type'] || '';
      if (!contentType.includes('application/json')) {
        return json({ error: 'Content-Type must be application/json' }, 415);
      }
      try {
        const bodyStr = await readBody();
        const body = JSON.parse(bodyStr);
        const result = await validator.validate(body);
        return json(result);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Unknown error';
        if (message === 'Payload too large') {
          return json({ error: 'Payload too large' }, 413);
        }
        if (message === 'Request body read timeout') {
          return json({ error: 'Request timeout' }, 408);
        }
        return json({ valid: false, errors: [message] }, 400);
      }
    }

    // Submit proposal (requires auth)
    if (url.pathname === '/api/proposals' && req.method === 'POST') {
      const contentType = req.headers['content-type'] || '';
      if (!contentType.includes('application/json')) {
        return json({ error: 'Content-Type must be application/json' }, 415);
      }
      // In production, verify signature and stake
      return json({ error: 'Unauthorized - signature required' }, 401);
    }

    // gRPC health check - calls trader via gRPC
    if (url.pathname === '/api/grpc/health') {
      const startTime = Date.now();
      try {
        const traderHealth = await traderClient.healthCheck();
        const duration = (Date.now() - startTime) / 1000;
        grpcCallDuration.labels('healthCheck').observe(duration);
        return json({
          grpcConnected: true,
          trader: traderHealth,
        });
      } catch (e: unknown) {
        const duration = (Date.now() - startTime) / 1000;
        grpcCallDuration.labels('healthCheck').observe(duration);
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
    logger.info({ httpPort }, 'HTTP server listening, ready to accept connections');
  });

  // ============================================================================
  // Graceful Shutdown
  // ============================================================================
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Received signal, shutting down gracefully');

    // Step 1: Close HTTP server — stop accepting new connections
    await new Promise<void>((resolve) => {
      server.close((err) => {
        if (err) {
          logger.error({ err }, 'Error closing HTTP server');
        } else {
          logger.info('HTTP server closed');
        }
        resolve();
      });
    });

    // Step 2: Stop P2P node
    if (p2pBridge) {
      try {
        await p2pBridge.stop();
        logger.info('P2P node stopped');
      } catch (err) {
        logger.error({ err }, 'Error stopping P2P node');
      }
    }

    // Step 3: Stop job distributor sweep and close Redis
    jobDistributor.stop();
    await closeRedisClient();
    logger.info('Redis closed');
    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

