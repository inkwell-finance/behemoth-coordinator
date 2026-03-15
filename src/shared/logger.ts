/**
 * Structured logger for behemoth-coordinator.
 * Wraps pino with a fixed service name and consistent JSON output.
 */

import pino from 'pino';

export const logger = pino({
  name: 'behemoth-coordinator',
  level: process.env.LOG_LEVEL ?? 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: 'behemoth-coordinator' },
});

export default logger;
