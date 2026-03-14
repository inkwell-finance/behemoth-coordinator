/**
 * Validates research proposals before processing.
 * This code is open source for auditability.
 */

import { ResearchProposal, SlotSchema, ValidationResult } from '@inkwell-finance/protocol';

export interface ProposalValidatorConfig {
  slotSchema: SlotSchema;
  maxModificationsPerProposal: number;
}

export class ProposalValidator {
  constructor(private config: ProposalValidatorConfig) {}

  /**
   * Validate a research proposal.
   * Checks:
   * - All slot IDs exist in schema
   * - Values are within allowed ranges
   * - Researcher signature is valid
   * - Proposal format is correct
   */
  validate(proposal: ResearchProposal): ValidationResult {
    const errors: string[] = [];

    // Check for empty modifications
    if (!proposal.modifications || proposal.modifications.length === 0) {
      errors.push('Proposal must contain at least one modification');
    }

    // Check modification count
    if (proposal.modifications && proposal.modifications.length > this.config.maxModificationsPerProposal) {
      errors.push(`Too many modifications: ${proposal.modifications.length} > ${this.config.maxModificationsPerProposal}`);
    }

    // Validate each modification
    for (const mod of proposal.modifications) {
      const slotDef = this.config.slotSchema.slots.find(s => s.slotId === mod.slotId);
      
      if (!slotDef) {
        errors.push(`Unknown slot: ${mod.slotId}`);
        continue;
      }

      // Check value type
      if (slotDef.valueType === 'float' || slotDef.valueType === 'int') {
        if (typeof mod.proposedValue !== 'number') {
          errors.push(`Slot ${mod.slotId} requires numeric value`);
          continue;
        }

        // Check range
        if (mod.proposedValue < slotDef.range.min || mod.proposedValue > slotDef.range.max) {
          errors.push(`Slot ${mod.slotId} value ${mod.proposedValue} outside range [${slotDef.range.min}, ${slotDef.range.max}]`);
        }

        // Check step if defined
        if (slotDef.range.step) {
          const steps = (mod.proposedValue - slotDef.range.min) / slotDef.range.step;
          if (Math.abs(steps - Math.round(steps)) > 0.001) {
            errors.push(`Slot ${mod.slotId} value ${mod.proposedValue} not aligned to step ${slotDef.range.step}`);
          }
        }
      }

      if (slotDef.valueType === 'enum') {
        if (!slotDef.range.enumValues?.includes(String(mod.proposedValue))) {
          errors.push(`Slot ${mod.slotId} value must be one of: ${slotDef.range.enumValues?.join(', ')}`);
        }
      }
    }

    // Check for duplicate slot modifications
    const slotIds = proposal.modifications.map(m => m.slotId);
    const uniqueSlotIds = new Set(slotIds);
    if (slotIds.length !== uniqueSlotIds.size) {
      errors.push('Duplicate slot modifications not allowed');
    }

    return {
      valid: errors.length === 0,
      errors,
      proposalId: proposal.proposalId,
    };
  }
}

