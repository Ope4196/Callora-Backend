/**
 * Unit tests for retry mechanism with exponential backoff.
 */

import { withRetry, createRetryWrapper } from './retry.js';
import { RetryExhaustedError } from './errors.js';

describe('Retry Mechanism', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('withRetry', () => {
    it('should return result on first successful attempt', async () => {
      const operation = jest.fn().mockResolvedValue('success');

      const promise = withRetry(operation);
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should retry and succeed after transient failure', async () => {
      const operation = jest
        .fn()
        .mockRejectedValueOnce(new Error('Transient failure'))
        .mockResolvedValueOnce('success');

      const promise = withRetry(operation, { maxAttempts: 3 });
      
      // Fast-forward through retry delays
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('should throw RetryExhaustedError after max attempts', async () => {
      const error = new Error('Persistent failure');
      const operation = jest.fn().mockRejectedValue(error);

      const promise = withRetry(operation, { maxAttempts: 3 });
      await jest.runAllTimersAsync();

      await expect(promise).rejects.toThrow(RetryExhaustedError);
      await expect(promise).rejects.toMatchObject({
        attempts: 3,
        lastError: error,
      });
      expect(operation).toHaveBeenCalledTimes(3);
    });

    it('should apply exponential backoff delays', async () => {
      const operation = jest.fn().mockRejectedValue(new Error('Failure'));
      const baseDelayMs = 1000;

      const promise = withRetry(operation, {
        maxAttempts: 3,
        baseDelayMs,
        jitterFactor: 0, // No jitter for predictable testing
      });

      // First attempt fails immediately
      await jest.advanceTimersByTimeAsync(0);
      expect(operation).toHaveBeenCalledTimes(1);

      // Second attempt after ~1000ms (2^0 * 1000)
      await jest.advanceTimersByTimeAsync(1000);
      expect(operation).toHaveBeenCalledTimes(2);

      // Third attempt after ~2000ms (2^1 * 1000)
      await jest.advanceTimersByTimeAsync(2000);
      expect(operation).toHaveBeenCalledTimes(3);

      await expect(promise).rejects.toThrow(RetryExhaustedError);
    });

    it('should cap delay at maxDelayMs', async () => {
      const operation = jest.fn().mockRejectedValue(new Error('Failure'));

      const promise = withRetry(operation, {
        maxAttempts: 4,
        baseDelayMs: 1000,
        maxDelayMs: 2000,
        jitterFactor: 0,
      });

      await jest.advanceTimersByTimeAsync(0);
      expect(operation).toHaveBeenCalledTimes(1);

      // Second attempt: 1000ms
      await jest.advanceTimersByTimeAsync(1000);
      expect(operation).toHaveBeenCalledTimes(2);

      // Third attempt: capped at 2000ms (not 2000ms)
      await jest.advanceTimersByTimeAsync(2000);
      expect(operation).toHaveBeenCalledTimes(3);

      // Fourth attempt: still capped at 2000ms (not 4000ms)
      await jest.advanceTimersByTimeAsync(2000);
      expect(operation).toHaveBeenCalledTimes(4);

      await expect(promise).rejects.toThrow(RetryExhaustedError);
    });

    it('should handle non-Error rejections', async () => {
      const operation = jest.fn().mockRejectedValue('string error');

      const promise = withRetry(operation, { maxAttempts: 2 });
      await jest.runAllTimersAsync();

      await expect(promise).rejects.toThrow(RetryExhaustedError);
      const error = await promise.catch((e) => e);
      expect(error.lastError.message).toBe('string error');
    });

    it('should use default config when not provided', async () => {
      const operation = jest.fn().mockRejectedValue(new Error('Failure'));

      const promise = withRetry(operation);
      await jest.runAllTimersAsync();

      await expect(promise).rejects.toThrow(RetryExhaustedError);
      expect(operation).toHaveBeenCalledTimes(3); // Default maxAttempts
    });
  });

  describe('createRetryWrapper', () => {
    it('should create a wrapper with pre-configured settings', async () => {
      const retryWrapper = createRetryWrapper({ maxAttempts: 2, baseDelayMs: 500 });
      const operation = jest.fn().mockRejectedValue(new Error('Failure'));

      const promise = retryWrapper(operation);
      await jest.runAllTimersAsync();

      await expect(promise).rejects.toThrow(RetryExhaustedError);
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('should allow multiple operations with same config', async () => {
      const retryWrapper = createRetryWrapper({ maxAttempts: 2 });

      const op1 = jest.fn().mockResolvedValue('result1');
      const op2 = jest.fn().mockResolvedValue('result2');

      const promise1 = retryWrapper(op1);
      const promise2 = retryWrapper(op2);

      await jest.runAllTimersAsync();

      await expect(promise1).resolves.toBe('result1');
      await expect(promise2).resolves.toBe('result2');
    });
  });

  describe('Jitter behavior', () => {
    it('should apply jitter to delay calculations', async () => {
      const operation = jest.fn().mockRejectedValue(new Error('Failure'));
      const delays: number[] = [];

      // Mock setTimeout to capture actual delays
      const originalSetTimeout = global.setTimeout;
      jest.spyOn(global, 'setTimeout').mockImplementation(((callback: any, ms: number) => {
        delays.push(ms);
        return originalSetTimeout(callback, 0);
      }) as any);

      const promise = withRetry(operation, {
        maxAttempts: 3,
        baseDelayMs: 1000,
        jitterFactor: 0.3,
      });

      await jest.runAllTimersAsync();
      await promise.catch(() => {}); // Ignore error

      // Verify delays are within jitter range
      expect(delays.length).toBe(2); // Two retries
      expect(delays[0]).toBeGreaterThanOrEqual(700); // 1000 * (1 - 0.3)
      expect(delays[0]).toBeLessThanOrEqual(1300); // 1000 * (1 + 0.3)
    });
  });
});
