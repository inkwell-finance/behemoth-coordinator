/**
 * Distributes backtest jobs to compute nodes.
 * Uses redundancy for verifiable compute.
 */

import { BacktestJob, JobAssignment, ComputeNode } from '@inkwell-finance/protocol';

export interface JobDistributorConfig {
  redundancyFactor: number;  // How many nodes run each job (e.g., 3)
  auditSampleRate: number;   // Random audit rate (e.g., 0.05 = 5%)
  jobTimeoutMs: number;      // Max time for job completion
  maxRetries: number;        // Retries before job fails
}

export class JobDistributor {
  private pendingJobs: Map<string, PendingJob> = new Map();
  private nodeAssignments: Map<string, string[]> = new Map(); // nodeId -> jobIds

  constructor(private config: JobDistributorConfig) {}

  /**
   * Create a new backtest job and assign to compute nodes.
   */
  createJob(proposalId: string, availableNodes: ComputeNode[]): JobAssignment[] {
    const jobId = `job-${proposalId}-${Date.now()}`;
    
    // Select nodes for redundancy
    const selectedNodes = this.selectNodes(availableNodes, this.config.redundancyFactor);
    
    if (selectedNodes.length < this.config.redundancyFactor) {
      throw new Error(`Insufficient compute nodes: need ${this.config.redundancyFactor}, have ${selectedNodes.length}`);
    }

    // Decide if this job will be audited
    const willAudit = Math.random() < this.config.auditSampleRate;

    // Create pending job record
    this.pendingJobs.set(jobId, {
      jobId,
      proposalId,
      assignedNodes: selectedNodes.map(n => n.peerId),
      results: new Map(),
      createdAt: Date.now(),
      timeoutAt: Date.now() + this.config.jobTimeoutMs,
      willAudit,
      status: 'pending',
    });

    // Create assignments
    return selectedNodes.map(node => ({
      jobId,
      nodeId: node.peerId,
      proposalId,
      assignedAt: Date.now(),
      timeoutAt: Date.now() + this.config.jobTimeoutMs,
    }));
  }

  /**
   * Submit result from a compute node.
   */
  submitResult(jobId: string, nodeId: string, result: JobResult): void {
    const job = this.pendingJobs.get(jobId);
    if (!job) {
      throw new Error(`Unknown job: ${jobId}`);
    }

    if (!job.assignedNodes.includes(nodeId)) {
      throw new Error(`Node ${nodeId} not assigned to job ${jobId}`);
    }

    job.results.set(nodeId, result);

    // Check if we have enough results
    if (job.results.size >= this.config.redundancyFactor) {
      this.finalizeJob(job);
    }
  }

  /**
   * Finalize a job by checking consensus.
   */
  private finalizeJob(job: PendingJob): void {
    const results = Array.from(job.results.values());
    
    // Check consensus - results should match within tolerance
    const consensusResult = this.checkConsensus(results);
    
    if (consensusResult.hasConsensus) {
      job.status = 'completed';
      job.finalResult = consensusResult.consensusValue;
      job.nodesAgreed = consensusResult.agreeingNodes;
      job.nodesDisputed = consensusResult.disputingNodes;
    } else {
      job.status = 'disputed';
      job.nodesDisputed = results.map((_, i) => job.assignedNodes[i]);
    }
  }

  /**
   * Select nodes for job assignment.
   * Prefers nodes with higher reputation and lower current load.
   */
  private selectNodes(nodes: ComputeNode[], count: number): ComputeNode[] {
    // Sort by reputation (descending) then load (ascending)
    const sorted = [...nodes].sort((a, b) => {
      if (a.reputation !== b.reputation) {
        return b.reputation - a.reputation;
      }
      return a.currentJobs - b.currentJobs;
    });

    // Select top nodes, but add some randomness to prevent predictability
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
   * Check if results agree within tolerance.
   */
  private checkConsensus(results: JobResult[]): ConsensusCheck {
    // Implementation: compare results and find majority
    // For now, simple majority check
    const tolerance = 0.001; // 0.1% tolerance
    const groups: JobResult[][] = [];

    for (const result of results) {
      let foundGroup = false;
      for (const group of groups) {
        if (Math.abs(group[0].score - result.score) <= tolerance) {
          group.push(result);
          foundGroup = true;
          break;
        }
      }
      if (!foundGroup) {
        groups.push([result]);
      }
    }

    // Find largest group
    groups.sort((a, b) => b.length - a.length);
    const majorityGroup = groups[0];

    return {
      hasConsensus: majorityGroup.length >= Math.ceil(results.length / 2),
      consensusValue: majorityGroup[0].score,
      agreeingNodes: majorityGroup.map(r => r.nodeId),
      disputingNodes: groups.slice(1).flat().map(r => r.nodeId),
    };
  }
}

interface PendingJob {
  jobId: string;
  proposalId: string;
  assignedNodes: string[];
  results: Map<string, JobResult>;
  createdAt: number;
  timeoutAt: number;
  willAudit: boolean;
  status: 'pending' | 'completed' | 'disputed' | 'timeout';
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

