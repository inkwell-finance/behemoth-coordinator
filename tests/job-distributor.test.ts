/**
 * Tests for JobDistributor
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { JobDistributor, JobDistributorConfig } from '../src/jobs/distributor';
import { ComputeNode } from '@inkwell-finance/behemoth-protocol';

describe('JobDistributor', () => {
  let distributor: JobDistributor;
  
  const config: JobDistributorConfig = {
    redundancyFactor: 3,
    auditSampleRate: 0.1,
    jobTimeoutMs: 60000,
    maxRetries: 3,
  };

  const createNodes = (count: number): ComputeNode[] => {
    return Array.from({ length: count }, (_, i) => ({
      peerId: `node-${i}`,
      publicKey: `pk-${i}`,
      reputation: 100 - i * 5,
      currentJobs: i % 3,
      maxJobs: 10,
      isOnline: true,
      lastSeen: Date.now(),
    }));
  };

  beforeEach(() => {
    distributor = new JobDistributor(config);
  });

  describe('createJob', () => {
    it('creates job with correct number of assignments', () => {
      const nodes = createNodes(5);
      const assignments = distributor.createJob('prop-123', nodes);
      
      expect(assignments).toHaveLength(config.redundancyFactor);
    });

    it('assigns to different nodes', () => {
      const nodes = createNodes(5);
      const assignments = distributor.createJob('prop-123', nodes);
      
      const nodeIds = assignments.map(a => a.nodeId);
      const uniqueNodeIds = new Set(nodeIds);
      expect(uniqueNodeIds.size).toBe(config.redundancyFactor);
    });

    it('throws when insufficient nodes available', () => {
      const nodes = createNodes(2); // Less than redundancyFactor
      
      expect(() => distributor.createJob('prop-123', nodes)).toThrow('Insufficient compute nodes');
    });

    it('assigns unique job IDs', () => {
      const nodes = createNodes(5);
      const assignments1 = distributor.createJob('prop-123', nodes);
      const assignments2 = distributor.createJob('prop-456', nodes);
      
      expect(assignments1[0].jobId).not.toBe(assignments2[0].jobId);
    });

    it('sets correct timeout', () => {
      const nodes = createNodes(5);
      const before = Date.now();
      const assignments = distributor.createJob('prop-123', nodes);
      const after = Date.now();
      
      for (const assignment of assignments) {
        expect(assignment.timeoutAt).toBeGreaterThanOrEqual(before + config.jobTimeoutMs);
        expect(assignment.timeoutAt).toBeLessThanOrEqual(after + config.jobTimeoutMs + 100);
      }
    });

    it('prefers higher reputation nodes', () => {
      const nodes = createNodes(10);
      
      // Run multiple times and check distribution
      const assignmentCounts = new Map<string, number>();
      
      for (let i = 0; i < 100; i++) {
        const assignments = distributor.createJob(`prop-${i}`, nodes);
        for (const a of assignments) {
          assignmentCounts.set(a.nodeId, (assignmentCounts.get(a.nodeId) || 0) + 1);
        }
      }
      
      // Higher reputation nodes (node-0, node-1) should have more assignments
      const node0Count = assignmentCounts.get('node-0') || 0;
      const node9Count = assignmentCounts.get('node-9') || 0;
      
      expect(node0Count).toBeGreaterThan(node9Count);
    });
  });

  describe('submitResult', () => {
    it('accepts result from assigned node', () => {
      const nodes = createNodes(5);
      const assignments = distributor.createJob('prop-123', nodes);
      
      const result = {
        nodeId: assignments[0].nodeId,
        score: 0.05,
        computeTimeMs: 1500,
        hash: 'hash-123',
      };
      
      // Should not throw
      expect(() => distributor.submitResult(assignments[0].jobId, assignments[0].nodeId, result)).not.toThrow();
    });

    it('rejects result from unassigned node', () => {
      const nodes = createNodes(5);
      const assignments = distributor.createJob('prop-123', nodes);
      
      const result = {
        nodeId: 'unauthorized-node',
        score: 0.05,
        computeTimeMs: 1500,
        hash: 'hash-123',
      };
      
      expect(() => distributor.submitResult(assignments[0].jobId, 'unauthorized-node', result))
        .toThrow('not assigned');
    });

    it('rejects result for unknown job', () => {
      const result = {
        nodeId: 'node-0',
        score: 0.05,
        computeTimeMs: 1500,
        hash: 'hash-123',
      };
      
      expect(() => distributor.submitResult('unknown-job', 'node-0', result))
        .toThrow('Unknown job');
    });
  });
});

