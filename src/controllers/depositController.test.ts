/**
 * Integration tests for deposit controller with error mapping.
 */

import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { buildDepositTransaction, getDepositHealth } from './depositController.js';
import { getTransactionBuilder, resetTransactionBuilder } from '../services/transactionBuilder.js';
import { CircuitBreakerOpenError, RetryExhaustedError, BadRequestError } from '../lib/errors.js';

// Mock the transaction builder
jest.mock('../services/transactionBuilder.js');

describe('Deposit Controller', () => {
  let app: express.Application;
  let mockTransactionBuilder: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup Express app with routes
    app = express();
    app.use(express.json());

    app.post('/api/deposits/build', buildDepositTransaction);
    app.get('/api/deposits/health', getDepositHealth);

    // Error handler middleware
    app.use((err: any, req: Request, res: Response, next: NextFunction) => {
      const statusCode = err.statusCode || 500;
      res.status(statusCode).json({
        success: false,
        error: err.message || 'Internal server error',
      });
    });

    // Setup mock transaction builder
    mockTransactionBuilder = {
      buildVaultDepositTransaction: jest.fn(),
      getMetrics: jest.fn(),
    };

    (getTransactionBuilder as jest.Mock).mockReturnValue(mockTransactionBuilder);
  });

  afterEach(() => {
    resetTransactionBuilder();
  });

  describe('POST /api/deposits/build', () => {
    const validRequest = {
      sourcePublicKey: 'GSOURCE123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
      vaultPublicKey: 'GVAULT123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ2345678',
      amount: '100.5',
    };

    it('should build transaction successfully', async () => {
      const mockXdr = 'AAAAA...mock_xdr...ZZZZZ';
      mockTransactionBuilder.buildVaultDepositTransaction.mockResolvedValue(mockXdr);

      const response = await request(app)
        .post('/api/deposits/build')
        .send(validRequest)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        transactionXdr: mockXdr,
      });

      expect(mockTransactionBuilder.buildVaultDepositTransaction).toHaveBeenCalledWith({
        sourcePublicKey: validRequest.sourcePublicKey,
        vaultPublicKey: validRequest.vaultPublicKey,
        amount: validRequest.amount,
      });
    });

    it('should return 400 for missing sourcePublicKey', async () => {
      const response = await request(app)
        .post('/api/deposits/build')
        .send({
          vaultPublicKey: validRequest.vaultPublicKey,
          amount: validRequest.amount,
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Invalid request body');
    });

    it('should return 400 for missing vaultPublicKey', async () => {
      const response = await request(app)
        .post('/api/deposits/build')
        .send({
          sourcePublicKey: validRequest.sourcePublicKey,
          amount: validRequest.amount,
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Invalid request body');
    });

    it('should return 400 for missing amount', async () => {
      const response = await request(app)
        .post('/api/deposits/build')
        .send({
          sourcePublicKey: validRequest.sourcePublicKey,
          vaultPublicKey: validRequest.vaultPublicKey,
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Invalid request body');
    });

    it('should return 400 for invalid amount (negative)', async () => {
      const response = await request(app)
        .post('/api/deposits/build')
        .send({
          ...validRequest,
          amount: '-50',
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Invalid request body');
    });

    it('should return 400 for invalid amount (zero)', async () => {
      const response = await request(app)
        .post('/api/deposits/build')
        .send({
          ...validRequest,
          amount: '0',
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Invalid request body');
    });

    it('should return 400 for invalid amount (non-numeric)', async () => {
      const response = await request(app)
        .post('/api/deposits/build')
        .send({
          ...validRequest,
          amount: 'not-a-number',
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Invalid request body');
    });

    it('should return 400 for empty string fields', async () => {
      const response = await request(app)
        .post('/api/deposits/build')
        .send({
          sourcePublicKey: '',
          vaultPublicKey: validRequest.vaultPublicKey,
          amount: validRequest.amount,
        })
        .expect(400);

      expect(response.body.success).toBe(false);
    });

    it('should return 502 for CircuitBreakerOpenError', async () => {
      mockTransactionBuilder.buildVaultDepositTransaction.mockRejectedValue(
        new CircuitBreakerOpenError('Circuit breaker is open')
      );

      const response = await request(app)
        .post('/api/deposits/build')
        .send(validRequest)
        .expect(502);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Stellar Horizon service is currently unavailable');
      expect(response.body.error).toContain('Circuit breaker is open');
    });

    it('should return 502 for RetryExhaustedError', async () => {
      const lastError = new Error('Connection timeout');
      mockTransactionBuilder.buildVaultDepositTransaction.mockRejectedValue(
        new RetryExhaustedError(3, lastError)
      );

      const response = await request(app)
        .post('/api/deposits/build')
        .send(validRequest)
        .expect(502);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Failed to connect to Stellar Horizon');
      expect(response.body.error).toContain('multiple retries');
    });

    it('should return 500 for unexpected errors', async () => {
      mockTransactionBuilder.buildVaultDepositTransaction.mockRejectedValue(
        new Error('Unexpected internal error')
      );

      const response = await request(app)
        .post('/api/deposits/build')
        .send(validRequest)
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Unexpected internal error');
    });

    it('should handle malformed JSON', async () => {
      const response = await request(app)
        .post('/api/deposits/build')
        .set('Content-Type', 'application/json')
        .send('{ invalid json }')
        .expect(400);

      expect(response.body).toBeDefined();
    });

    it('should handle null request body', async () => {
      const response = await request(app)
        .post('/api/deposits/build')
        .send(null)
        .expect(400);

      expect(response.body.success).toBe(false);
    });

    it('should handle array instead of object', async () => {
      const response = await request(app)
        .post('/api/deposits/build')
        .send([validRequest])
        .expect(400);

      expect(response.body.success).toBe(false);
    });
  });

  describe('GET /api/deposits/health', () => {
    it('should return circuit breaker metrics', async () => {
      const mockMetrics = {
        state: 'CLOSED',
        consecutiveFailures: 0,
        consecutiveSuccesses: 5,
        totalFailures: 2,
        totalSuccesses: 10,
        lastFailureTime: null,
        lastStateChange: Date.now(),
      };

      mockTransactionBuilder.getMetrics.mockReturnValue(mockMetrics);

      const response = await request(app)
        .get('/api/deposits/health')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        circuitBreaker: mockMetrics,
      });

      expect(mockTransactionBuilder.getMetrics).toHaveBeenCalledTimes(1);
    });

    it('should handle errors in health endpoint', async () => {
      mockTransactionBuilder.getMetrics.mockImplementation(() => {
        throw new Error('Metrics unavailable');
      });

      const response = await request(app)
        .get('/api/deposits/health')
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Metrics unavailable');
    });

    it('should return OPEN state when circuit is tripped', async () => {
      const mockMetrics = {
        state: 'OPEN',
        consecutiveFailures: 5,
        consecutiveSuccesses: 0,
        totalFailures: 15,
        totalSuccesses: 10,
        lastFailureTime: Date.now(),
        lastStateChange: Date.now(),
      };

      mockTransactionBuilder.getMetrics.mockReturnValue(mockMetrics);

      const response = await request(app)
        .get('/api/deposits/health')
        .expect(200);

      expect(response.body.circuitBreaker.state).toBe('OPEN');
      expect(response.body.circuitBreaker.consecutiveFailures).toBe(5);
    });

    it('should return HALF_OPEN state during recovery', async () => {
      const mockMetrics = {
        state: 'HALF_OPEN',
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        totalFailures: 10,
        totalSuccesses: 5,
        lastFailureTime: Date.now() - 30000,
        lastStateChange: Date.now(),
      };

      mockTransactionBuilder.getMetrics.mockReturnValue(mockMetrics);

      const response = await request(app)
        .get('/api/deposits/health')
        .expect(200);

      expect(response.body.circuitBreaker.state).toBe('HALF_OPEN');
    });
  });

  describe('Error handler integration', () => {
    it('should properly format BadRequestError', async () => {
      const response = await request(app)
        .post('/api/deposits/build')
        .send({ invalid: 'data' })
        .expect(400);

      expect(response.body).toMatchObject({
        success: false,
        error: expect.any(String),
      });
    });

    it('should properly format BadGatewayError from circuit breaker', async () => {
      mockTransactionBuilder.buildVaultDepositTransaction.mockRejectedValue(
        new CircuitBreakerOpenError()
      );

      const response = await request(app)
        .post('/api/deposits/build')
        .send({
          sourcePublicKey: 'GSOURCE123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
          vaultPublicKey: 'GVAULT123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ2345678',
          amount: '100',
        })
        .expect(502);

      expect(response.body).toMatchObject({
        success: false,
        error: expect.stringContaining('unavailable'),
      });
    });
  });

  describe('Content-Type validation', () => {
    it('should accept application/json', async () => {
      mockTransactionBuilder.buildVaultDepositTransaction.mockResolvedValue('XDR_DATA');

      const response = await request(app)
        .post('/api/deposits/build')
        .set('Content-Type', 'application/json')
        .send({
          sourcePublicKey: 'GSOURCE123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
          vaultPublicKey: 'GVAULT123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ2345678',
          amount: '100',
        })
        .expect(200);

      expect(response.body.success).toBe(true);
    });
  });
});
