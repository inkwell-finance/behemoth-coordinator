/**
 * Distributes backtest jobs to compute nodes.
 * Uses redundancy for verifiable compute.
 * Job state and results are persisted to Redis so they survive restarts.
 *
 * Redis layout:
 *   behemoth:coordinator:jobs:pending          HASH  jobId -> PendingJobData (JSON)
 *   behemoth:coordinator:jobs:results:<jobId>  HASH  nodeId -> JobResult (JSON)
 *   behemoth:coordinator:proposals:queue       LIST  proposalId queue (when no nodes available)
 *   behemoth:coordinator:proposals:queue:<proposalId>  STRING  ProposalData (JSON, with TTL 1 hour)
 */

import { BacktestJob, JobAssignment, ComputeNode, ResearchProposal } from '@inkwell-finance/behemoth-protocol';
import type Redis from 'ioredis';
import { getRedisClient } from '../shared/redis.js';
import { jobFinalizationDuration, jobsFinalizedTotal, proposalQueueDepth, proposalQueueRejectionsTotal } from '../metrics.js';
import logger from '../shared/logger.js';

// ---------------------------------------------------------------------------
// Redis key helpers
// ---------------------------------------------------------------------------

const KEYS = {
  pendingJobs: 'behemoth:coordinator:jobs:pending',
  results: (jobId: string) => `behemoth:coordinator:jobs:results:${jobId}`,
  proposalQueue: 'behemoth:coordinator:proposals:queue',
  proposalData: (proposalId: string) => `behemoth:coordinator:proposals:queue:${proposalId}`,
} as const;

const QUEUE_CONFIG = {
  MAX_QUEUE_DEPTH: 1000,
  QUEUE_TTL_SECONDS: 60 * 60, // 1 hour
} as const;

// ---------------------------------------------------------------------------
// Public config
// ---------------------------------------------------------------------------

export interface JobDistributorConfig {
  redundancyFactor: number;  // How many nodes run each job (e.g., 3)
  auditSampleRate: number;   // Random audit rate (e.g., 0.05 = 5%)
  jobTimeoutMs: number;      // Max time for job completion
  maxRetries: number;        // Retries before job fails
}

// ---------------------------------------------------------------------------
// Internal types (serialisable — no Map)
// ---------------------------------------------------------------------------

interface PendingJobData {
  jobId: string;
  proposalId: string;
  assignedNodes: string[];
  createdAt: number;
  timeoutAt: number;
  willAudit: boolean;
  status: 'pending' | 'completed' | 'disputed' | 'timeout';
  finalized: boolean;
  finalResult?: number;
  nodesAgreed?: string[];
  nodesDisputed?: string[];
}

interface JobResult {
  nodeId: string;
  score: number;
  computeTimeMs: number;
  hash: string; // Hash of full result for verification
}

interface ConsensusCheck {
  hasConsensus: boolean;
  consensusValue: number;
  agreeingNodes: string[];
  disputingNodes: string[];
}

// ---------------------------------------------------------------------------
// JobDistributor
// ---------------------------------------------------------------------------

export class JobDistributor {
  private redis: Redis;
  private timeoutTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private config: JobDistributorConfig) {
    this.redis = getRedisClient();
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /**
   * Load pending jobs from Redis and start the periodic timeout sweep.
   * Call once after construction, before processing proposals.
   */
  async init(): Promise<void> {
    const count = await this.countPendingJobs();
    logger.info({ count }, 'Loaded pending jobs from Redis');

    const queueCount = await this.countQueuedProposals();
    proposalQueueDepth.set(queueCount);
    logger.info({ count: queueCount }, 'Loaded queued proposals from Redis');

    // Sweep every 30 s for timed-out jobs
    this.timeoutTimer = setInterval(() => {
      this.sweepTimeouts().catch(err =>
        logger.error({ err }, 'Timeout sweep error'),
      );
    }, 30_000);
    // Queue sweep is handled by index.ts (which has full P2P context).
  }

  /** Stop the background timeout sweep. */
  stop(): void {
    if (this.timeoutTimer !== null) {
      clearInterval(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Create a new backtest job and assign to compute nodes.
   * Persists the pending-job record to Redis before returning assignments.
   */
  async createJob(proposalId: string, availableNodes: ComputeNode[]): Promise<JobAssignment[]> {
    const jobId = `job-${proposalId}-${Date.now()}`;
    const selectedNodes = this.selectNodes(availableNodes, this.config.redundancyFactor);

    if (selectedNodes.length < this.config.redundancyFactor) {
      throw new Error(
        `Insufficient compute nodes: need ${this.config.redundancyFactor}, have ${selectedNodes.length}`,
      );
    }

    const willAudit = Math.random() < this.config.auditSampleRate;
    const now = Date.now();

    const jobData: PendingJobData = {
      jobId,
      proposalId,
      assignedNodes: selectedNodes.map(n => n.peerId),
      createdAt: now,
      timeoutAt: now + this.config.jobTimeoutMs,
      willAudit,
      status: 'pending',
      finalized: false,
    };

    // Persist to Redis
    await this.redis.hset(KEYS.pendingJobs, jobId, JSON.stringify(jobData));

    return selectedNodes.map(node => ({
      jobId,
      nodeId: node.peerId,
      proposalId,
      assignedAt: now,
      timeoutAt: jobData.timeoutAt,
    }));
  }

  /**
   * Enqueue a proposal when no compute nodes are available.
   * Returns 'pending' status and will be retried when nodes become available.
   * Rejects if queue is full or proposal already queued.
   */
  async enqueueProposal(proposal: ResearchProposal): Promise<'pending' | 'rejected'> {
    const queueCount = await this.countQueuedProposals();

    if (queueCount >= QUEUE_CONFIG.MAX_QUEUE_DEPTH) {
      logger.warn({ queueCount, maxDepth: QUEUE_CONFIG.MAX_QUEUE_DEPTH, proposalId: proposal.proposalId }, 'Proposal queue full, rejecting proposal');
      proposalQueueRejectionsTotal.inc();
      return 'rejected';
    }

    // Check if already queued
    const existingData = await this.redis.get(KEYS.proposalData(proposal.proposalId));
    if (existingData) {
      logger.info({ proposalId: proposal.proposalId }, 'Proposal already queued, not adding duplicate');
      return 'pending';
    }

    // Add to queue and store proposal data with TTL (atomic pipeline)
    const pipeline = this.redis.pipeline();
    pipeline.rpush(KEYS.proposalQueue, proposal.proposalId);
    pipeline.setex(KEYS.proposalData(proposal.proposalId), QUEUE_CONFIG.QUEUE_TTL_SECONDS, JSON.stringify(proposal));
    await pipeline.exec();

    const newDepth = queueCount + 1;
    proposalQueueDepth.set(newDepth);
    logger.info({ proposalId: proposal.proposalId, queueSize: newDepth }, 'Proposal enqueued');
    return 'pending';
  }

  /**
   * Submit a result from a compute node.
   * Persists the result and, once enough results are in, finalises the job.
   * Returns true if this submission caused the job to finalize, false otherwise.
   */
  async submitResult(jobId: string, nodeId: string, result: JobResult): Promise<boolean> {
    const jobData = await this.loadJob(jobId);
    if (!jobData) {
      throw new Error(`Unknown job: ${jobId}`);
    }

    if (!jobData.assignedNodes.includes(nodeId)) {
      throw new Error(`Node ${nodeId} not assigned to job ${jobId}`);
    }

    if (jobData.finalized) {
      throw new Error(`Job ${jobId} is already finalized; late result from ${nodeId} rejected`);
    }

    // Persist individual result
    await this.redis.hset(KEYS.results(jobId), nodeId, JSON.stringify(result));
    // Set TTL on results hash as defense-in-depth against orphaned hashes
    const ttlSeconds = Math.ceil(this.config.jobTimeoutMs / 1000) * 3;
    await this.redis.expire(KEYS.results(jobId), ttlSeconds);

    // Load all results so far to check consensus
    const allResults = await this.loadResults(jobId);

    if (allResults.length >= this.config.redundancyFactor) {
      await this.finalizeJob(jobData, allResults);
      return true;
    }

    return false;
  }

  // --------------------------------------------------------------------------
  // Queue sweep (for proposals when nodes were unavailable)
  // --------------------------------------------------------------------------

  /**
   * Dequeue a proposal from the pending queue.
   * Call this after successfully creating a job for a queued proposal.
   */
  async dequeueProposal(proposalId: string): Promise<void> {
    // Remove from queue
    await this.redis.lrem(KEYS.proposalQueue, 0, proposalId);
    // Remove proposal data
    await this.redis.del(KEYS.proposalData(proposalId));
    // Update queue depth metric
    const depth = await this.countQueuedProposals();
    proposalQueueDepth.set(depth);
    logger.info({ proposalId }, 'Dequeued proposal');
  }

  // --------------------------------------------------------------------------
  // Timeout sweep
  // --------------------------------------------------------------------------

  /**
   * Mark jobs past their deadline as 'timeout' and remove them from pending.
   */
  async sweepTimeouts(): Promise<number> {
    const all = await this.redis.hgetall(KEYS.pendingJobs);
    const now = Date.now();
    let timedOut = 0;

    for (const [jobId, raw] of Object.entries(all)) {
      let job: PendingJobData;
      try {
        job = JSON.parse(raw) as PendingJobData;
      } catch {
        continue;
      }

      if (!job.finalized && job.status === 'pending' && now > job.timeoutAt) {
        job.status = 'timeout';
        // Record job finalization duration and increment counter
        const durationSeconds = (now - job.createdAt) / 1000;
        jobFinalizationDuration.observe(durationSeconds);
        jobsFinalizedTotal.inc({ result: job.status });
        // Keep the record for audit — update status in-place, then remove from pending
        // We remove from pending hash; results key keeps its own TTL (none — durable).
        await this.redis.hdel(KEYS.pendingJobs, jobId);
        // Clean up orphaned results hash
        await this.redis.del(KEYS.results(jobId));
        logger.warn({ jobId, proposalId: job.proposalId }, 'Job timed out');
        timedOut++;
      }
    }

    return timedOut;
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private async loadJob(jobId: string): Promise<PendingJobData | null> {
    const raw = await this.redis.hget(KEYS.pendingJobs, jobId);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PendingJobData;
    } catch {
      return null;
    }
  }

  private async loadResults(jobId: string): Promise<JobResult[]> {
    const all = await this.redis.hgetall(KEYS.results(jobId));
    const results: JobResult[] = [];
    for (const raw of Object.values(all)) {
      try {
        results.push(JSON.parse(raw) as JobResult);
      } catch {
        // skip corrupt entries
      }
    }
    return results;
  }

  private async countPendingJobs(): Promise<number> {
    return this.redis.hlen(KEYS.pendingJobs);
  }

  private async countQueuedProposals(): Promise<number> {
    return this.redis.llen(KEYS.proposalQueue);
  }

  /**
   * Get the next queued proposal if any are available (without removing it).
   * The caller should call dequeueProposal() after successfully processing it.
   */
  async getNextQueuedProposal(): Promise<ResearchProposal | null> {
    const proposalId = await this.redis.lindex(KEYS.proposalQueue, 0);
    if (!proposalId) {
      return null;
    }

    const proposalData = await this.redis.get(KEYS.proposalData(proposalId));
    if (!proposalData) {
      // Data expired, remove from queue
      await this.redis.lpop(KEYS.proposalQueue);
      proposalQueueDepth.set(await this.countQueuedProposals());
      return null;
    }

    try {
      return JSON.parse(proposalData) as ResearchProposal;
    } catch {
      // Corrupt data, remove from queue
      await this.redis.lpop(KEYS.proposalQueue);
      await this.redis.del(KEYS.proposalData(proposalId));
      proposalQueueDepth.set(await this.countQueuedProposals());
      return null;
    }
  }

  /**
   * Atomically pop and return the next queued proposal (LPOP-based, no TOCTOU).
   * Replaces the peek (getNextQueuedProposal) + remove (dequeueProposal) pattern.
   * Returns null if the queue is empty or the popped proposal's data has expired/is corrupt.
   */
  async dequeueNextProposal(): Promise<ResearchProposal | null> {
    const proposalId = await this.redis.lpop(KEYS.proposalQueue);
    if (!proposalId) return null;
    const data = await this.redis.get(KEYS.proposalData(proposalId));
    if (!data) {
      proposalQueueDepth.set(await this.countQueuedProposals());
      logger.info({ proposalId }, 'Dropped expired queued proposal (atomic dequeue)');
      return null;
    }
    await this.redis.del(KEYS.proposalData(proposalId));
    proposalQueueDepth.set(await this.redis.llen(KEYS.proposalQueue));
    try {
      return JSON.parse(data) as ResearchProposal;
    } catch {
      logger.warn({ proposalId }, 'Dropped corrupted queued proposal (atomic dequeue)');
      return null;
    }
  }

  /**
   * Finalise a job: check consensus, update status in Redis, clean up pending entry.
   */
  private async finalizeJob(job: PendingJobData, results: JobResult[]): Promise<void> {
    const consensus = this.checkConsensus(results);

    if (consensus.hasConsensus) {
      job.status = 'completed';
      job.finalResult = consensus.consensusValue;
      job.nodesAgreed = consensus.agreeingNodes;
      job.nodesDisputed = consensus.disputingNodes;
    } else {
      job.status = 'disputed';
      job.nodesDisputed = results.map(r => r.nodeId);
    }

    job.finalized = true;

    // Record job finalization duration and increment counter
    const durationSeconds = (Date.now() - job.createdAt) / 1000;
    jobFinalizationDuration.observe(durationSeconds);
    jobsFinalizedTotal.inc({ result: job.status });

    // Remove from pending (job is done)
    await this.redis.hdel(KEYS.pendingJobs, job.jobId);
  }

  /**
   * Select nodes for job assignment.
   * Prefers nodes with higher reputation and lower current load.
   */
  private selectNodes(nodes: ComputeNode[], count: number): ComputeNode[] {
    const sorted = [...nodes].sort((a, b) => {
      if (a.reputation !== b.reputation) {
        return b.reputation - a.reputation;
      }
      return a.currentJobs - b.currentJobs;
    });

    // Select top nodes with some randomness to prevent predictability
    const pool = sorted.slice(0, Math.min(count * 3, sorted.length));
    const selected: ComputeNode[] = [];

    while (selected.length < count && pool.length > 0) {
      const idx = Math.floor(Math.random() * pool.length);
      selected.push(pool[idx]);
      pool.splice(idx, 1);
    }

    return selected;
  }

  /**
   * Check if results agree within tolerance (majority rules).
   */
  private checkConsensus(results: JobResult[]): ConsensusCheck {
    const groups: JobResult[][] = [];

    for (const result of results) {
      let foundGroup = false;
      for (const group of groups) {
        const diff = Math.abs(group[0].score - result.score);
        const base = Math.abs(group[0].score);
        const isClose = base < 0.01
          ? diff <= 0.001  // absolute tolerance for near-zero
          : diff / base <= 0.01;  // 1% relative for larger scores
        if (isClose) {
          group.push(result);
          foundGroup = true;
          break;
        }
      }
      if (!foundGroup) {
        groups.push([result]);
      }
    }

    groups.sort((a, b) => b.length - a.length);
    const majorityGroup = groups[0];

    return {
      hasConsensus: majorityGroup.length >= Math.ceil(results.length / 2),
      consensusValue: majorityGroup.length > 0
        ? majorityGroup.reduce((sum, r) => sum + r.score, 0) / majorityGroup.length
        : 0,
      agreeingNodes: majorityGroup.map(r => r.nodeId),
      disputingNodes: groups.slice(1).flat().map(r => r.nodeId),
    };
  }
}
