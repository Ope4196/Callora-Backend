/**
 * Unit and integration tests for Stellar transaction builder with resilience patterns.
 */

import { StellarTransactionBuilder, resetTransactionBuilder, getTransactionBuilder } from './transactionBuilder.js';
import { CircuitBreakerOpenError, RetryExhaustedError } from '../lib/errors.js';
import { Server } from 'stellar-sdk';

// Mock stellar-sdk
jest.mock('stellar-sdk');

describe('StellarTransactionBuilder', () => {
  let mockServer: jest.Mocked<Server>;
  let mockLoadAccount: jest.Mock;
  let mockFeeStats: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    resetTransactionBuilder();

    // Setup mock server
    mockLoadAccount = jest.fn();
    mockFeeStats = jest.fn();

    mockServer = {
      loadAccount: mockLoadAccount,
      feeStats: mockFeeStats,
    } as any;

    (Server as jest.MockedClass<typeof Server>).mockImplementation(() => mockServer);
  });

  afterEach(() => {
    resetTransactionBuilder();
  });

  describe('Constructor and configuration', () => {
    it('should use default configuration', () => {
      const builder = new StellarTransactionBuilder();
      const config = builder.getConfig();

      expect(config.horizonUrl).toBe('https://horizon-testnet.stellar.org');
      expect(config.baseFee).toBe('100');
      expect(config.transactionTimeout).toBe(30);
      expect(config.circuitBreakerThreshold).toBe(5);
      expect(config.circuitBreakerCooldownMs).toBe(30000);
      expect(config.retryMaxAttempts).toBe(3);
    });

    it('should use custom configuration', () => {
      const builder = new StellarTransactionBuilder({
        horizonUrl: 'https://custom-horizon.example.com',
        baseFee: '200',
        circuitBreakerThreshold: 10,
      });

      const config = builder.getConfig();

      expect(config.horizonUrl).toBe('https://custom-horizon.example.com');
      expect(config.baseFee).toBe('200');
      expect(config.circuitBreakerThreshold).toBe(10);
    });

    it('should respect environment variables', () => {
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        HORIZON_URL: 'https://env-horizon.example.com',
        STELLAR_BASE_FEE: '150',
        CIRCUIT_BREAKER_THRESHOLD: '7',
      };

      const builder = new StellarTransactionBuilder();
      const config = builder.getConfig();

      expect(config.horizonUrl).toBe('https://env-horizon.example.com');
      expect(config.baseFee).toBe('150');
      expect(config.circuitBreakerThreshold).toBe(7);

      process.env = originalEnv;
    });
  });

  describe('loadAccount', () => {
    it('should load account successfully on first try', async () => {
      const mockAccount = { id: 'GTEST123', sequence: '123456' };
      mockLoadAccount.mockResolvedValue(mockAccount);

      const builder = new StellarTransactionBuilder();
      const result = await builder.loadAccount('GTEST123');

      expect(result).toEqual(mockAccount);
      expect(mockLoadAccount).toHaveBeenCalledTimes(1);
      expect(mockLoadAccount).toHaveBeenCalledWith('GTEST123');
    });

    it('should retry and succeed after transient failure', async () => {
      jest.useFakeTimers();

      const mockAccount = { id: 'GTEST123', sequence: '123456' };
      mockLoadAccount
        .mockRejectedValueOnce(new Error('Network timeout'))
        .mockResolvedValueOnce(mockAccount);

      const builder = new StellarTransactionBuilder({
        retryMaxAttempts: 3,
        retryBaseDelayMs: 100,
      });

      const promise = builder.loadAccount('GTEST123');
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual(mockAccount);
      expect(mockLoadAccount).toHaveBeenCalledTimes(2);

      jest.useRealTimers();
    });

    it('should throw RetryExhaustedError after max attempts', async () => {
      jest.useFakeTimers();

      mockLoadAccount.mockRejectedValue(new Error('Persistent failure'));

      const builder = new StellarTransactionBuilder({
        retryMaxAttempts: 3,
        retryBaseDelayMs: 100,
      });

      const promise = builder.loadAccount('GTEST123');
      await jest.runAllTimersAsync();

      await expect(promise).rejects.toThrow(RetryExhaustedError);
      expect(mockLoadAccount).toHaveBeenCalledTimes(3);

      jest.useRealTimers();
    });

    it('should trip circuit breaker after threshold failures', async () => {
      jest.useFakeTimers();

      mockLoadAccount.mockRejectedValue(new Error('Service unavailable'));

      const builder = new StellarTransactionBuilder({
        circuitBreakerThreshold: 2,
        retryMaxAttempts: 1, // No retries to simplify test
      });

      // First failure
      await expect(builder.loadAccount('GTEST1')).rejects.toThrow();

      // Second failure trips the breaker
      await expect(builder.loadAccount('GTEST2')).rejects.toThrow();

      // Third call should fast-fail with CircuitBreakerOpenError
      await expect(builder.loadAccount('GTEST3')).rejects.toThrow(CircuitBreakerOpenError);

      // Verify the operation wasn't called the third time
      expect(mockLoadAccount).toHaveBeenCalledTimes(2);

      jest.useRealTimers();
    });

    it('should recover from open circuit after cooldown', async () => {
      jest.useFakeTimers();

      const mockAccount = { id: 'GTEST123', sequence: '123456' };
      mockLoadAccount
        .mockRejectedValueOnce(new Error('Failure 1'))
        .mockRejectedValueOnce(new Error('Failure 2'))
        .mockResolvedValueOnce(mockAccount);

      const builder = new StellarTransactionBuilder({
        circuitBreakerThreshold: 2,
        circuitBreakerCooldownMs: 5000,
        retryMaxAttempts: 1,
      });

      // Trip the breaker
      await builder.loadAccount('GTEST1').catch(() => {});
      await builder.loadAccount('GTEST2').catch(() => {});

      // Verify circuit is open
      await expect(builder.loadAccount('GTEST3')).rejects.toThrow(CircuitBreakerOpenError);

      // Advance time past cooldown
      jest.advanceTimersByTime(5000);

      // Should allow probe and succeed
      const result = await builder.loadAccount('GTEST4');
      expect(result).toEqual(mockAccount);

      jest.useRealTimers();
    });
  });

  describe('fetchBaseFee', () => {
    it('should fetch base fee successfully', async () => {
      mockFeeStats.mockResolvedValue({
        max_fee: { mode: '150' },
      });

      const builder = new StellarTransactionBuilder();
      const fee = await builder.fetchBaseFee();

      expect(fee).toBe('150');
      expect(mockFeeStats).toHaveBeenCalledTimes(1);
    });

    it('should fall back to configured fee on failure', async () => {
      jest.useFakeTimers();

      mockFeeStats.mockRejectedValue(new Error('Fee stats unavailable'));

      const builder = new StellarTransactionBuilder({
        baseFee: '200',
        retryMaxAttempts: 2,
      });

      const promise = builder.fetchBaseFee();
      await jest.runAllTimersAsync();
      const fee = await promise;

      expect(fee).toBe('200');

      jest.useRealTimers();
    });

    it('should retry fee fetch with exponential backoff', async () => {
      jest.useFakeTimers();

      mockFeeStats
        .mockRejectedValueOnce(new Error('Timeout'))
        .mockResolvedValueOnce({ max_fee: { mode: '175' } });

      const builder = new StellarTransactionBuilder({
        retryMaxAttempts: 3,
        retryBaseDelayMs: 100,
      });

      const promise = builder.fetchBaseFee();
      await jest.runAllTimersAsync();
      const fee = await promise;

      expect(fee).toBe('175');
      expect(mockFeeStats).toHaveBeenCalledTimes(2);

      jest.useRealTimers();
    });
  });

  describe('buildVaultDepositTransaction', () => {
    beforeEach(() => {
      // Mock successful account load and fee fetch
      mockLoadAccount.mockResolvedValue({
        id: 'GSOURCE123',
        sequence: '123456',
        accountId: () => 'GSOURCE123',
        sequenceNumber: () => '123456',
        incrementSequenceNumber: jest.fn(),
      });

      mockFeeStats.mockResolvedValue({
        max_fee: { mode: '100' },
      });
    });

    it('should build transaction successfully', async () => {
      const builder = new StellarTransactionBuilder();

      const xdr = await builder.buildVaultDepositTransaction({
        sourcePublicKey: 'GSOURCE123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
        vaultPublicKey: 'GVAULT123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ2345678',
        amount: '100.5',
      });

      expect(typeof xdr).toBe('string');
      expect(mockLoadAccount).toHaveBeenCalledWith('GSOURCE123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ234567');
    });

    it('should validate public keys', async () => {
      const builder = new StellarTransactionBuilder();

      await expect(
        builder.buildVaultDepositTransaction({
          sourcePublicKey: 'INVALID_KEY',
          vaultPublicKey: 'GVAULT123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ2345678',
          amount: '100',
        })
      ).rejects.toThrow('Invalid public key');
    });

    it('should propagate circuit breaker errors', async () => {
      jest.useFakeTimers();

      mockLoadAccount.mockRejectedValue(new Error('Service down'));

      const builder = new StellarTransactionBuilder({
        circuitBreakerThreshold: 1,
        retryMaxAttempts: 1,
      });

      // Trip the breaker
      await builder
        .buildVaultDepositTransaction({
          sourcePublicKey: 'GSOURCE123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
          vaultPublicKey: 'GVAULT123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ2345678',
          amount: '100',
        })
        .catch(() => {});

      // Should throw CircuitBreakerOpenError
      await expect(
        builder.buildVaultDepositTransaction({
          sourcePublicKey: 'GSOURCE123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
          vaultPublicKey: 'GVAULT123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ2345678',
          amount: '100',
        })
      ).rejects.toThrow(CircuitBreakerOpenError);

      jest.useRealTimers();
    });
  });

  describe('Singleton pattern', () => {
    it('should return same instance on multiple calls', () => {
      const instance1 = getTransactionBuilder();
      const instance2 = getTransactionBuilder();

      expect(instance1).toBe(instance2);
    });

    it('should create new instance after reset', () => {
      const instance1 = getTransactionBuilder();
      resetTransactionBuilder();
      const instance2 = getTransactionBuilder();

      expect(instance1).not.toBe(instance2);
    });
  });

  describe('Metrics', () => {
    it('should expose circuit breaker metrics', async () => {
      const builder = new StellarTransactionBuilder();
      const metrics = builder.getMetrics();

      expect(metrics).toHaveProperty('state');
      expect(metrics).toHaveProperty('totalFailures');
      expect(metrics).toHaveProperty('totalSuccesses');
    });
  });
});
