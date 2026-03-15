/**
 * Tests for ProposalValidator
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ProposalValidator, ProposalValidatorConfig } from '../src/gateway/proposal-validator';
import { SlotSchema, ResearchProposal } from '@inkwell-finance/behemoth-protocol';

describe('ProposalValidator', () => {
  let validator: ProposalValidator;
  
  const testSchema: SlotSchema = {
    version: '1.0.0',
    lastUpdated: Date.now(),
    slots: [
      {
        slotId: 'allocation_momentum',
        description: 'Momentum allocation weight',
        valueType: 'float',
        range: { min: 0, max: 1, step: 0.05 },
        category: 'allocation',
        currentValue: null,
      },
      {
        slotId: 'allocation_reversion',
        description: 'Mean reversion allocation weight',
        valueType: 'float',
        range: { min: 0, max: 1, step: 0.05 },
        category: 'allocation',
        currentValue: null,
      },
      {
        slotId: 'regime_type',
        description: 'Regime detection type',
        valueType: 'enum',
        range: { min: 0, max: 0, enumValues: ['low_vol', 'high_vol', 'trending', 'ranging'] },
        category: 'regime',
        currentValue: null,
      },
    ],
  };

  const config: ProposalValidatorConfig = {
    slotSchema: testSchema,
    maxModificationsPerProposal: 5,
  };

  beforeEach(() => {
    validator = new ProposalValidator(config);
  });

  const validProposal: ResearchProposal = {
    proposalId: 'prop-123-abc',
    researcher: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    timestamp: Date.now(),
    modifications: [
      { slotId: 'allocation_momentum', proposedValue: 0.35 },
    ],
    hypothesis: 'Increasing momentum allocation should improve returns.',
  };

  describe('valid proposals', () => {
    it('accepts proposal with valid slot modification', () => {
      const result = validator.validate(validProposal);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts proposal with multiple valid modifications', () => {
      const proposal: ResearchProposal = {
        ...validProposal,
        modifications: [
          { slotId: 'allocation_momentum', proposedValue: 0.4 },
          { slotId: 'allocation_reversion', proposedValue: 0.3 },
        ],
      };
      const result = validator.validate(proposal);
      expect(result.valid).toBe(true);
    });

    it('accepts enum slot modification', () => {
      const proposal: ResearchProposal = {
        ...validProposal,
        modifications: [
          { slotId: 'regime_type', proposedValue: 'high_vol' },
        ],
      };
      const result = validator.validate(proposal);
      expect(result.valid).toBe(true);
    });

    it('accepts value exactly at range boundary', () => {
      const proposal: ResearchProposal = {
        ...validProposal,
        modifications: [
          { slotId: 'allocation_momentum', proposedValue: 0 }, // min
        ],
      };
      expect(validator.validate(proposal).valid).toBe(true);
      
      proposal.modifications[0].proposedValue = 1; // max
      expect(validator.validate(proposal).valid).toBe(true);
    });
  });

  describe('invalid proposals', () => {
    it('rejects unknown slot', () => {
      const proposal: ResearchProposal = {
        ...validProposal,
        modifications: [
          { slotId: 'unknown_slot', proposedValue: 0.5 },
        ],
      };
      const result = validator.validate(proposal);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Unknown slot: unknown_slot');
    });

    it('rejects value below range', () => {
      const proposal: ResearchProposal = {
        ...validProposal,
        modifications: [
          { slotId: 'allocation_momentum', proposedValue: -0.1 },
        ],
      };
      const result = validator.validate(proposal);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('outside range'))).toBe(true);
    });

    it('rejects value above range', () => {
      const proposal: ResearchProposal = {
        ...validProposal,
        modifications: [
          { slotId: 'allocation_momentum', proposedValue: 1.5 },
        ],
      };
      const result = validator.validate(proposal);
      expect(result.valid).toBe(false);
    });

    it('rejects non-numeric value for float slot', () => {
      const proposal: ResearchProposal = {
        ...validProposal,
        modifications: [
          { slotId: 'allocation_momentum', proposedValue: 'not_a_number' },
        ],
      };
      const result = validator.validate(proposal);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('numeric'))).toBe(true);
    });

    it('rejects value not aligned to step', () => {
      const proposal: ResearchProposal = {
        ...validProposal,
        modifications: [
          { slotId: 'allocation_momentum', proposedValue: 0.37 }, // Not aligned to 0.05 step
        ],
      };
      const result = validator.validate(proposal);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('step'))).toBe(true);
    });
  });
});

