/**
 * Public slot schema - defines what researchers can modify.
 * This is PUBLIC knowledge.
 */

import { SlotSchema, SlotDefinition } from '@inkwell-finance/protocol';

/**
 * Current public slot schema.
 * Researchers see these slots and can propose modifications.
 * 
 * IMPORTANT: currentValue is ALWAYS null - never expose actual values.
 */
export const PUBLIC_SLOT_SCHEMA: SlotSchema = {
  version: '1.0.0',
  lastUpdated: Date.now(),
  slots: [
    // === ALLOCATION SLOTS ===
    {
      slotId: 'allocation_momentum_class',
      description: 'Weight allocated to trend-following signal group',
      valueType: 'float',
      range: { min: 0, max: 0.5, step: 0.01 },
      category: 'allocation',
      currentValue: null,
    },
    {
      slotId: 'allocation_mean_reversion_class',
      description: 'Weight allocated to mean-reversion signal group',
      valueType: 'float',
      range: { min: 0, max: 0.5, step: 0.01 },
      category: 'allocation',
      currentValue: null,
    },
    {
      slotId: 'allocation_microstructure_class',
      description: 'Weight allocated to microstructure signal group',
      valueType: 'float',
      range: { min: 0, max: 0.5, step: 0.01 },
      category: 'allocation',
      currentValue: null,
    },
    {
      slotId: 'allocation_cross_asset_class',
      description: 'Weight allocated to cross-asset signal group',
      valueType: 'float',
      range: { min: 0, max: 0.5, step: 0.01 },
      category: 'allocation',
      currentValue: null,
    },
    
    // === REGIME SLOTS ===
    {
      slotId: 'regime_vol_threshold',
      description: 'Volatility level triggering regime shift consideration',
      valueType: 'float',
      range: { min: 0.1, max: 3.0, step: 0.1 },
      category: 'threshold',
      currentValue: null,
    },
    {
      slotId: 'regime_trend_threshold',
      description: 'Trend strength for regime classification',
      valueType: 'float',
      range: { min: 0.3, max: 0.9, step: 0.05 },
      category: 'threshold',
      currentValue: null,
    },
    
    // === SIZING SLOTS ===
    {
      slotId: 'sizing_aggression',
      description: 'Kelly fraction multiplier for position sizing',
      valueType: 'float',
      range: { min: 0.1, max: 1.0, step: 0.05 },
      category: 'sizing',
      currentValue: null,
    },
    {
      slotId: 'sizing_max_position',
      description: 'Maximum position size as fraction of capital',
      valueType: 'float',
      range: { min: 0.01, max: 0.2, step: 0.01 },
      category: 'sizing',
      currentValue: null,
    },
    
    // === TIMING SLOTS ===
    {
      slotId: 'entry_confidence_threshold',
      description: 'Minimum signal confidence for entry',
      valueType: 'float',
      range: { min: 0.5, max: 0.95, step: 0.05 },
      category: 'timing',
      currentValue: null,
    },
    {
      slotId: 'exit_profit_target',
      description: 'Relative profit target multiplier',
      valueType: 'float',
      range: { min: 1.0, max: 5.0, step: 0.25 },
      category: 'timing',
      currentValue: null,
    },
    
    // === RISK SLOTS ===
    {
      slotId: 'risk_drawdown_limit',
      description: 'Maximum drawdown before position reduction',
      valueType: 'float',
      range: { min: 0.02, max: 0.15, step: 0.01 },
      category: 'risk',
      currentValue: null,
    },
    {
      slotId: 'risk_correlation_cap',
      description: 'Maximum allowed portfolio correlation',
      valueType: 'float',
      range: { min: 0.3, max: 0.8, step: 0.05 },
      category: 'risk',
      currentValue: null,
    },
  ],
};

/**
 * Get the current slot schema.
 */
export function getSlotSchema(): SlotSchema {
  return PUBLIC_SLOT_SCHEMA;
}

/**
 * Validate that a slot ID exists.
 */
export function isValidSlot(slotId: string): boolean {
  return PUBLIC_SLOT_SCHEMA.slots.some(s => s.slotId === slotId);
}

