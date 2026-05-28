/**
 * Deposit controller for vault deposit operations.
 * 
 * Handles HTTP requests for building vault deposit transactions.
 * Maps circuit breaker and retry failures to appropriate HTTP status codes.
 */

import { Request, Response, NextFunction } from 'express';
import { getTransactionBuilder } from '../services/transactionBuilder.js';
import { CircuitBreakerOpenError, RetryExhaustedError, BadGatewayError, BadRequestError } from '../lib/errors.js';

/**
 * Request body schema for vault deposit.
 */
interface DepositRequestBody {
  sourcePublicKey: string;
  vaultPublicKey: string;
  amount: string;
}

/**
 * Validate deposit request body.
 */
function validateDepositRequest(body: any): body is DepositRequestBody {
  if (!body || typeof body !== 'object') {
    return false;
  }

  const { sourcePublicKey, vaultPublicKey, amount } = body;

  if (typeof sourcePublicKey !== 'string' || !sourcePublicKey.trim()) {
    return false;
  }

  if (typeof vaultPublicKey !== 'string' || !vaultPublicKey.trim()) {
    return false;
  }

  if (typeof amount !== 'string' || !amount.trim()) {
    return false;
  }

  // Validate amount is a positive number
  const amountNum = parseFloat(amount);
  if (isNaN(amountNum) || amountNum <= 0) {
    return false;
  }

  return true;
}

/**
 * POST /api/deposits/build
 * 
 * Build a vault deposit transaction.
 * 
 * Request body:
 * - sourcePublicKey: Source account public key
 * - vaultPublicKey: Vault account public key
 * - amount: Amount to deposit (in XLM)
 * 
 * Response:
 * - transactionXdr: Unsigned transaction XDR
 * 
 * Error responses:
 * - 400: Invalid request body
 * - 502: Circuit breaker open or retry exhausted (upstream failure)
 * - 500: Internal server error
 */
export async function buildDepositTransaction(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Validate request body
    if (!validateDepositRequest(req.body)) {
      throw new BadRequestError(
        'Invalid request body. Required fields: sourcePublicKey, vaultPublicKey, amount (positive number)'
      );
    }

    const { sourcePublicKey, vaultPublicKey, amount } = req.body;

    // Build transaction with resilience patterns
    const transactionBuilder = getTransactionBuilder();
    const transactionXdr = await transactionBuilder.buildVaultDepositTransaction({
      sourcePublicKey,
      vaultPublicKey,
      amount,
    });

    res.status(200).json({
      success: true,
      transactionXdr,
    });
  } catch (error) {
    // Map specific errors to appropriate HTTP status codes
    if (error instanceof CircuitBreakerOpenError) {
      const badGatewayError = new BadGatewayError(
        'Stellar Horizon service is currently unavailable. Circuit breaker is open. Please try again later.'
      );
      next(badGatewayError);
    } else if (error instanceof RetryExhaustedError) {
      const badGatewayError = new BadGatewayError(
        'Failed to connect to Stellar Horizon after multiple retries. Please try again later.'
      );
      next(badGatewayError);
    } else if (error instanceof BadRequestError) {
      next(error);
    } else {
      // Pass other errors to the error handler
      next(error);
    }
  }
}

/**
 * GET /api/deposits/health
 * 
 * Get circuit breaker health metrics.
 * 
 * Response:
 * - state: Circuit breaker state (CLOSED, OPEN, HALF_OPEN)
 * - metrics: Detailed circuit breaker metrics
 */
export async function getDepositHealth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const transactionBuilder = getTransactionBuilder();
    const metrics = transactionBuilder.getMetrics();

    res.status(200).json({
      success: true,
      circuitBreaker: metrics,
    });
  } catch (error) {
    next(error);
  }
}
