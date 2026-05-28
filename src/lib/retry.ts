/**
 * Bounded retry mechanism with exponential backoff and jitter.
 * 
 * Configuration:
 * - maxAttempts: Maximum number of retry attempts (default: 3)
 * - baseDelayMs: Initial delay in milliseconds (default: 1000)
 * - maxDelayMs: Maximum delay cap in milliseconds (default: 10000)
 * - jitterFactor: Random jitter multiplier 0-1 (default: 0.3)
 */

import { RetryExhaustedError } from './errors.js';

export interface RetryConfig {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterFactor?: number;
}

const DEFAULT_CONFIG: Required<RetryConfig> = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  jitterFactor: 0.3,
};

/**
 * Calculate exponential backoff delay with jitter.
 * Formula: min(baseDelay * 2^attempt, maxDelay) * (1 ± jitter)
 */
function calculateDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitterFactor: number
): number {
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
  const jitter = 1 + (Math.random() * 2 - 1) * jitterFactor;
  return Math.floor(cappedDelay * jitter);
}

/**
 * Sleep for the specified duration.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async operation with exponential backoff.
 * 
 * @param operation - Async function to retry
 * @param config - Retry configuration
 * @returns Result of the operation
 * @throws RetryExhaustedError if all attempts fail
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  config: RetryConfig = {}
): Promise<T> {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  const { maxAttempts, baseDelayMs, maxDelayMs, jitterFactor } = finalConfig;

  let lastError: Error = new Error('Unknown error');

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await operation();
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on the last attempt
      if (attempt === maxAttempts - 1) {
        break;
      }

      const delayMs = calculateDelay(attempt, baseDelayMs, maxDelayMs, jitterFactor);
      console.warn(
        `Retry attempt ${attempt + 1}/${maxAttempts} failed: ${lastError.message}. ` +
        `Retrying in ${delayMs}ms...`
      );

      await sleep(delayMs);
    }
  }

  throw new RetryExhaustedError(maxAttempts, lastError);
}

/**
 * Create a retry wrapper with pre-configured settings.
 * Useful for creating service-specific retry policies.
 */
export function createRetryWrapper(config: RetryConfig) {
  return function retryWrapper<T>(operation: () => Promise<T>): Promise<T> {
    return withRetry(operation, config);
  };
}
