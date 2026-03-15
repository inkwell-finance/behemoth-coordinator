/**
 * Prometheus metrics for behemoth-coordinator
 *
 * Exposes counters, gauges, and histograms for monitoring:
 * - Proposal submission and validation
 * - Job creation and finalization
 * - P2P peer connectivity
 * - gRPC communication latency
 */

import { Registry, Counter, Gauge, Histogram } from 'prom-client';

// Create a dedicated registry for coordinator metrics
export const register = new Registry();

// ============================================================================
// COUNTERS - Monotonically increasing values
// ============================================================================

/**
 * Total number of proposals received
 * Labels: status (valid, invalid, rate_limited)
 */
export const proposalsReceivedTotal = new Counter({
  name: 'proposals_received_total',
  help: 'Total proposals received by the coordinator',
  labelNames: ['status'],
  registers: [register],
});

/**
 * Total number of backtest jobs created
 */
export const jobsCreatedTotal = new Counter({
  name: 'jobs_created_total',
  help: 'Total backtest jobs created by the coordinator',
  registers: [register],
});

/**
 * Total number of backtest jobs finalized
 * Labels: result (consensus, disputed, timeout)
 */
export const jobsFinalizedTotal = new Counter({
  name: 'jobs_finalized_total',
  help: 'Total backtest jobs finalized (consensus reached or timed out)',
  labelNames: ['result'],
  registers: [register],
});

/**
 * Total number of job results received from compute nodes
 * Labels: node_id (peer ID of the compute node)
 */
export const resultsReceivedTotal = new Counter({
  name: 'results_received_total',
  help: 'Total job results received from compute nodes',
  labelNames: ['node_id'],
  registers: [register],
});

/**
 * Total number of proposals rejected due to queue overflow
 */
export const proposalQueueRejectionsTotal = new Counter({
  name: 'proposal_queue_rejections_total',
  help: 'Proposals rejected due to queue overflow',
  registers: [register],
});

/**
 * Total number of proposals rejected due to a duplicate nonce (replay attack attempts)
 */
export const duplicateNonceRejectionsTotal = new Counter({
  name: 'duplicate_nonce_rejections_total',
  help: 'Proposals rejected due to duplicate nonce (replay attack attempts)',
  registers: [register],
});

/**
 * Total number of P2P direct send failures where pubsub fallback also failed
 */
export const failedBroadcastsTotal = new Counter({
  name: 'failed_broadcasts_total',
  help: 'Total P2P direct sends where both direct and pubsub fallback failed',
  registers: [register],
});

// ============================================================================
// GAUGES - Values that can go up or down
// ============================================================================

/**
 * Current number of pending jobs (awaiting consensus or finalization)
 */
export const pendingJobsCount = new Gauge({
  name: 'pending_jobs_count',
  help: 'Number of jobs awaiting finalization',
  registers: [register],
});

/**
 * Current number of connected P2P peers
 */
export const connectedPeersCount = new Gauge({
  name: 'connected_peers_count',
  help: 'Number of connected P2P peers',
  registers: [register],
});

/**
 * Current number of connected compute nodes
 */
export const connectedComputeNodesCount = new Gauge({
  name: 'connected_compute_nodes_count',
  help: 'Number of connected compute nodes',
  registers: [register],
});

/**
 * Current depth of the proposal queue (proposals waiting for compute nodes)
 */
export const proposalQueueDepth = new Gauge({
  name: 'proposal_queue_depth',
  help: 'Number of proposals waiting in queue for available compute nodes',
  registers: [register],
});

// ============================================================================
// HISTOGRAMS - Distribution of latencies
// ============================================================================

/**
 * Duration of proposal validation
 */
export const proposalValidationDuration = new Histogram({
  name: 'proposal_validation_duration_seconds',
  help: 'Time taken to validate a proposal',
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0],
  registers: [register],
});

/**
 * Duration of job finalization (from job creation to consensus)
 */
export const jobFinalizationDuration = new Histogram({
  name: 'job_finalization_duration_seconds',
  help: 'Time taken to finalize a job (consensus or timeout)',
  buckets: [1, 5, 10, 30, 60, 120, 300],
  registers: [register],
});

/**
 * Duration of gRPC calls to the trader service
 * Labels: method (method name being called)
 */
export const grpcCallDuration = new Histogram({
  name: 'grpc_call_duration_seconds',
  help: 'Duration of gRPC calls to the trader service',
  labelNames: ['method'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1.0, 2.0, 5.0],
  registers: [register],
});
