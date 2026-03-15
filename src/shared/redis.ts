// Redis client singleton for the coordinator.
// Uses ioredis. Reads REDIS_URL from environment (default: redis://localhost:6379).

import Redis from 'ioredis';
import logger from './logger.js';

let _client: Redis | null = null;

/**
 * Returns the shared ioredis client, creating it on first call.
 * Reads REDIS_URL from the environment; falls back to redis://localhost:6379.
 * Supports optional REDIS_PASSWORD environment variable for authentication.
 */
export function getRedisClient(): Redis {
  if (_client) return _client;

  const url = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  const password = process.env['REDIS_PASSWORD'];

  // Warn if production without password
  if (process.env['NODE_ENV'] === 'production' && !password) {
    logger.warn('REDIS_PASSWORD not set in production');
  }

  const config: any = {
    // Exponential back-off capped at 5 s
    retryStrategy: (times: number) => Math.min(times * 200, 5_000),
    lazyConnect: false,
    maxRetriesPerRequest: 3,
  };

  // Add password if provided
  if (password) {
    config.password = password;
  }

  _client = new Redis(url, config);

  _client.on('error', (err: Error) => {
    logger.error({ err: err.message }, 'Redis connection error');
  });

  return _client;
}

/**
 * Wait for Redis to be available before proceeding.
 * Attempts to ping Redis with retries and a timeout.
 * @param timeoutMs - Maximum time to wait (default: 10 seconds)
 * @throws Error if Redis is not available after timeout
 */
export async function waitForRedis(timeoutMs = 10_000): Promise<void> {
  const client = getRedisClient();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await client.ping();
      logger.info('Redis connected and ready');
      return;
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error(`Redis not available after ${timeoutMs}ms`);
}

/**
 * Close the shared client. Call during graceful shutdown.
 */
export async function closeRedisClient(): Promise<void> {
  if (_client) {
    await _client.quit();
    _client = null;
  }
}
