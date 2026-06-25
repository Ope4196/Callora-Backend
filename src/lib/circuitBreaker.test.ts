/**
 * Unit tests for circuit breaker pattern implementation.
 */

import { CircuitBreaker, CircuitBreakerState } from './circuitBreaker.js';
import { CircuitBreakerOpenError } from './errors.js';

const TEST_BREAKER_KEY = 'test-breaker';

describe('Circuit Breaker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('State transitions', () => {
    it('should start in CLOSED state', async () => {
      const breaker = new CircuitBreaker();
      expect(await breaker.getState(TEST_BREAKER_KEY)).toBe(CircuitBreakerState.CLOSED);
    });

    it('should transition to OPEN after threshold failures', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 3 });
      const operation = jest.fn().mockRejectedValue(new Error('Failure'));

      // Execute failures up to threshold
      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute(TEST_BREAKER_KEY, operation)).rejects.toThrow('Failure');
      }

      expect(await breaker.getState(TEST_BREAKER_KEY)).toBe(CircuitBreakerState.OPEN);
      expect(operation).toHaveBeenCalledTimes(3);
    });

    it('should fast-fail when OPEN', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 5000 });
      const operation = jest.fn().mockRejectedValue(new Error('Failure'));

      // Trip the breaker
      await breaker.execute(TEST_BREAKER_KEY, operation).catch(() => {});
      await breaker.execute(TEST_BREAKER_KEY, operation).catch(() => {});

      expect(await breaker.getState(TEST_BREAKER_KEY)).toBe(CircuitBreakerState.OPEN);

      // Should fast-fail without calling operation
      await expect(breaker.execute(TEST_BREAKER_KEY, operation)).rejects.toThrow(CircuitBreakerOpenError);
      expect(operation).toHaveBeenCalledTimes(2); // Not called again
    });

    it('should transition to HALF_OPEN after cooldown', async () => {
      jest.useFakeTimers();

      const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 5000 });
      const operation = jest.fn().mockRejectedValue(new Error('Failure'));

      // Trip the breaker
      await breaker.execute(TEST_BREAKER_KEY, operation).catch(() => {});
      await breaker.execute(TEST_BREAKER_KEY, operation).catch(() => {});

      expect(await breaker.getState(TEST_BREAKER_KEY)).toBe(CircuitBreakerState.OPEN);

      // Advance time past cooldown
      jest.advanceTimersByTime(5000);

      // Next execution should transition to HALF_OPEN
      const successOp = jest.fn().mockResolvedValue('success');
      await breaker.execute(TEST_BREAKER_KEY, successOp);

      expect(await breaker.getState(TEST_BREAKER_KEY)).toBe(CircuitBreakerState.CLOSED);

      jest.useRealTimers();
    });

    it('should transition back to CLOSED on success in HALF_OPEN', async () => {
      jest.useFakeTimers();

      const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000 });
      const failOp = jest.fn().mockRejectedValue(new Error('Failure'));

      // Trip the breaker
      await breaker.execute(TEST_BREAKER_KEY, failOp).catch(() => {});
      await breaker.execute(TEST_BREAKER_KEY, failOp).catch(() => {});

      expect(await breaker.getState(TEST_BREAKER_KEY)).toBe(CircuitBreakerState.OPEN);

      // Wait for cooldown
      jest.advanceTimersByTime(1000);

      // Successful probe should close the circuit
      const successOp = jest.fn().mockResolvedValue('success');
      await breaker.execute(TEST_BREAKER_KEY, successOp);

      expect(await breaker.getState(TEST_BREAKER_KEY)).toBe(CircuitBreakerState.CLOSED);

      jest.useRealTimers();
    });

    it('should return to OPEN on failure in HALF_OPEN', async () => {
      jest.useFakeTimers();

      const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000 });
      const failOp = jest.fn().mockRejectedValue(new Error('Failure'));

      // Trip the breaker
      await breaker.execute(TEST_BREAKER_KEY, failOp).catch(() => {});
      await breaker.execute(TEST_BREAKER_KEY, failOp).catch(() => {});

      expect(await breaker.getState(TEST_BREAKER_KEY)).toBe(CircuitBreakerState.OPEN);

      // Wait for cooldown
      jest.advanceTimersByTime(1000);

      // Failed probe should return to OPEN
      await breaker.execute(TEST_BREAKER_KEY, failOp).catch(() => {});

      expect(await breaker.getState(TEST_BREAKER_KEY)).toBe(CircuitBreakerState.OPEN);

      jest.useRealTimers();
    });

    it('should reset consecutive failures on success in CLOSED', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 3 });
      const failOp = jest.fn().mockRejectedValue(new Error('Failure'));
      const successOp = jest.fn().mockResolvedValue('success');

      // Two failures
      await breaker.execute(TEST_BREAKER_KEY, failOp).catch(() => {});
      await breaker.execute(TEST_BREAKER_KEY, failOp).catch(() => {});

      expect(await breaker.getState(TEST_BREAKER_KEY)).toBe(CircuitBreakerState.CLOSED);

      // Success resets counter
      await breaker.execute(TEST_BREAKER_KEY, successOp);

      // Two more failures shouldn't trip (counter was reset)
      await breaker.execute(TEST_BREAKER_KEY, failOp).catch(() => {});
      await breaker.execute(TEST_BREAKER_KEY, failOp).catch(() => {});

      expect(await breaker.getState(TEST_BREAKER_KEY)).toBe(CircuitBreakerState.CLOSED);
    });
  });

  describe('Metrics', () => {
    it('should track success and failure counts', async () => {
      const breaker = new CircuitBreaker();
      const successOp = jest.fn().mockResolvedValue('success');
      const failOp = jest.fn().mockRejectedValue(new Error('Failure'));

      await breaker.execute(TEST_BREAKER_KEY, successOp);
      await breaker.execute(TEST_BREAKER_KEY, successOp);
      await breaker.execute(TEST_BREAKER_KEY, failOp).catch(() => {});

      const metrics = await breaker.getMetrics(TEST_BREAKER_KEY);

      expect(metrics.totalSuccesses).toBe(2);
      expect(metrics.totalFailures).toBe(1);
      expect(metrics.consecutiveSuccesses).toBe(0);
      expect(metrics.consecutiveFailures).toBe(1);
    });

    it('should track last failure time', async () => {
      const breaker = new CircuitBreaker();
      const failOp = jest.fn().mockRejectedValue(new Error('Failure'));

      const beforeTime = Date.now();
      await breaker.execute(TEST_BREAKER_KEY, failOp).catch(() => {});
      const afterTime = Date.now();

      const metrics = await breaker.getMetrics(TEST_BREAKER_KEY);

      expect(metrics.lastFailureTime).toBeGreaterThanOrEqual(beforeTime);
      expect(metrics.lastFailureTime).toBeLessThanOrEqual(afterTime);
    });

    it('should track state changes', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 2 });
      const failOp = jest.fn().mockRejectedValue(new Error('Failure'));

      const initialMetrics = await breaker.getMetrics(TEST_BREAKER_KEY);
      const initialStateChange = initialMetrics.lastStateChange;

      // Trip the breaker
      await breaker.execute(TEST_BREAKER_KEY, failOp).catch(() => {});
      await breaker.execute(TEST_BREAKER_KEY, failOp).catch(() => {});

      const finalMetrics = await breaker.getMetrics(TEST_BREAKER_KEY);

      expect(finalMetrics.state).toBe(CircuitBreakerState.OPEN);
      expect(finalMetrics.lastStateChange).toBeGreaterThan(initialStateChange);
    });
  });

  describe('Configuration', () => {
    it('should use custom failure threshold', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 5 });
      const failOp = jest.fn().mockRejectedValue(new Error('Failure'));

      // 4 failures shouldn't trip
      for (let i = 0; i < 4; i++) {
        await breaker.execute(TEST_BREAKER_KEY, failOp).catch(() => {});
      }

      expect(await breaker.getState(TEST_BREAKER_KEY)).toBe(CircuitBreakerState.CLOSED);

      // 5th failure should trip
      await breaker.execute(TEST_BREAKER_KEY, failOp).catch(() => {});
      expect(await breaker.getState(TEST_BREAKER_KEY)).toBe(CircuitBreakerState.OPEN);
    });

    it('should use custom cooldown period', async () => {
      jest.useFakeTimers();

      const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10000 });
      const failOp = jest.fn().mockRejectedValue(new Error('Failure'));

      // Trip the breaker
      await breaker.execute(TEST_BREAKER_KEY, failOp).catch(() => {});
      expect(await breaker.getState(TEST_BREAKER_KEY)).toBe(CircuitBreakerState.OPEN);

      // Advance time less than cooldown
      jest.advanceTimersByTime(5000);

      // Should still be open
      await expect(breaker.execute(TEST_BREAKER_KEY, failOp)).rejects.toThrow(CircuitBreakerOpenError);

      // Advance past cooldown
      jest.advanceTimersByTime(5000);

      // Should allow probe
      const successOp = jest.fn().mockResolvedValue('success');
      await breaker.execute(TEST_BREAKER_KEY, successOp);

      expect(await breaker.getState(TEST_BREAKER_KEY)).toBe(CircuitBreakerState.CLOSED);

      jest.useRealTimers();
    });

    it('should use custom success threshold in HALF_OPEN', async () => {
      jest.useFakeTimers();

      const breaker = new CircuitBreaker({
        failureThreshold: 2,
        cooldownMs: 1000,
        successThreshold: 2,
      });
      const failOp = jest.fn().mockRejectedValue(new Error('Failure'));
      const successOp = jest.fn().mockResolvedValue('success');

      // Trip the breaker
      await breaker.execute(TEST_BREAKER_KEY, failOp).catch(() => {});
      await breaker.execute(TEST_BREAKER_KEY, failOp).catch(() => {});

      // Wait for cooldown
      jest.advanceTimersByTime(1000);

      // First success shouldn't close
      await breaker.execute(TEST_BREAKER_KEY, successOp);
      expect(await breaker.getState(TEST_BREAKER_KEY)).toBe(CircuitBreakerState.HALF_OPEN);

      // Second success should close
      await breaker.execute(TEST_BREAKER_KEY, successOp);
      expect(await breaker.getState(TEST_BREAKER_KEY)).toBe(CircuitBreakerState.CLOSED);

      jest.useRealTimers();
    });
  });

  describe('Reset functionality', () => {
    it('should reset to CLOSED state', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 2 });
      const failOp = jest.fn().mockRejectedValue(new Error('Failure'));

      // Trip the breaker
      await breaker.execute(TEST_BREAKER_KEY, failOp).catch(() => {});
      await breaker.execute(TEST_BREAKER_KEY, failOp).catch(() => {});

      expect(await breaker.getState(TEST_BREAKER_KEY)).toBe(CircuitBreakerState.OPEN);

      // Reset
      await breaker.reset(TEST_BREAKER_KEY);

      expect(await breaker.getState(TEST_BREAKER_KEY)).toBe(CircuitBreakerState.CLOSED);

      // Should accept operations again
      const successOp = jest.fn().mockResolvedValue('success');
      await expect(breaker.execute(TEST_BREAKER_KEY, successOp)).resolves.toBe('success');
    });
  });

  describe('Concurrent operations', () => {
    it('should handle concurrent operations correctly', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 3 });
      const successOp = jest.fn().mockResolvedValue('success');

      // Execute multiple operations concurrently
      const promises = Array(10)
        .fill(null)
        .map(() => breaker.execute(TEST_BREAKER_KEY, successOp));

      const results = await Promise.all(promises);

      expect(results).toHaveLength(10);
      expect(results.every((r) => r === 'success')).toBe(true);
      expect(await breaker.getState(TEST_BREAKER_KEY)).toBe(CircuitBreakerState.CLOSED);
    });
  });
});
