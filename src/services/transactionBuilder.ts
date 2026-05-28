/**
 * Stellar transaction builder with resilience patterns.
 * 
 * Wraps Horizon network calls with:
 * - Exponential backoff retry logic
 * - Circuit breaker for fast-fail during outages
 * 
 * Environment Configuration:
 * - HORIZON_URL: Stellar Horizon endpoint (default: testnet)
 * - STELLAR_BASE_FEE: Transaction base fee in stroops (default: 100)
 * - STELLAR_TRANSACTION_TIMEOUT: Transaction timeout in seconds (default: 30)
 * - CIRCUIT_BREAKER_THRESHOLD: Failures before opening circuit (default: 5)
 * - CIRCUIT_BREAKER_COOLDOWN_MS: Cooldown period in ms (default: 30000)
 * - RETRY_MAX_ATTEMPTS: Max retry attempts (default: 3)
 * - RETRY_BASE_DELAY_MS: Initial retry delay in ms (default: 1000)
 */

import { Server, Networks, TransactionBuilder, Operation, Asset, Keypair } from 'stellar-sdk';
import { CircuitBreaker } from '../lib/circuitBreaker.js';
import { withRetry, RetryConfig } from '../lib/retry.js';

/**
 * Configuration for the transaction builder service.
 */
export interface TransactionBuilderConfig {
  horizonUrl?: string;
  networkPassphrase?: string;
  baseFee?: string;
  transactionTimeout?: number;
  circuitBreakerThreshold?: number;
  circuitBreakerCooldownMs?: number;
  retryMaxAttempts?: number;
  retryBaseDelayMs?: number;
}

/**
 * Parameters for building a vault deposit transaction.
 */
export interface VaultDepositParams {
  sourcePublicKey: string;
  vaultPublicKey: string;
  amount: string;
  asset?: Asset;
}

/**
 * Default configuration values from environment or fallback.
 */
function getDefaultConfig(): Required<TransactionBuilderConfig> {
  return {
    horizonUrl: process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org',
    networkPassphrase: process.env.STELLAR_NETWORK ?? Networks.TESTNET,
    baseFee: process.env.STELLAR_BASE_FEE ?? '100',
    transactionTimeout: parseInt(process.env.STELLAR_TRANSACTION_TIMEOUT ?? '30', 10),
    circuitBreakerThreshold: parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD ?? '5', 10),
    circuitBreakerCooldownMs: parseInt(process.env.CIRCUIT_BREAKER_COOLDOWN_MS ?? '30000', 10),
    retryMaxAttempts: parseInt(process.env.RETRY_MAX_ATTEMPTS ?? '3', 10),
    retryBaseDelayMs: parseInt(process.env.RETRY_BASE_DELAY_MS ?? '1000', 10),
  };
}

/**
 * Transaction builder service with resilience patterns.
 */
export class StellarTransactionBuilder {
  private readonly server: Server;
  private readonly config: Required<TransactionBuilderConfig>;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly retryConfig: RetryConfig;

  constructor(config: TransactionBuilderConfig = {}) {
    this.config = { ...getDefaultConfig(), ...config };
    this.server = new Server(this.config.horizonUrl);
    
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: this.config.circuitBreakerThreshold,
      cooldownMs: this.config.circuitBreakerCooldownMs,
    });

    this.retryConfig = {
      maxAttempts: this.config.retryMaxAttempts,
      baseDelayMs: this.config.retryBaseDelayMs,
    };
  }

  /**
   * Load account from Horizon with retry and circuit breaker protection.
   * 
   * @param publicKey - Stellar public key
   * @returns Account object from Horizon
   */
  async loadAccount(publicKey: string): Promise<any> {
    return this.circuitBreaker.execute(() =>
      withRetry(
        async () => {
          return await this.server.loadAccount(publicKey);
        },
        this.retryConfig
      )
    );
  }

  /**
   * Fetch current base fee from Horizon with retry and circuit breaker protection.
   * Falls back to configured base fee on failure.
   * 
   * @returns Base fee in stroops
   */
  async fetchBaseFee(): Promise<string> {
    try {
      return await this.circuitBreaker.execute(() =>
        withRetry(
          async () => {
            const feeStats = await this.server.feeStats();
            return feeStats.max_fee.mode;
          },
          this.retryConfig
        )
      );
    } catch (error) {
      console.warn(
        `Failed to fetch base fee from Horizon: ${error instanceof Error ? error.message : String(error)}. ` +
        `Using configured base fee: ${this.config.baseFee}`
      );
      return this.config.baseFee;
    }
  }

  /**
   * Build a vault deposit transaction.
   * 
   * @param params - Deposit parameters
   * @returns Unsigned transaction XDR
   */
  async buildVaultDepositTransaction(params: VaultDepositParams): Promise<string> {
    const { sourcePublicKey, vaultPublicKey, amount, asset = Asset.native() } = params;

    // Validate public keys
    try {
      Keypair.fromPublicKey(sourcePublicKey);
      Keypair.fromPublicKey(vaultPublicKey);
    } catch (error) {
      throw new Error(`Invalid public key: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Load source account with resilience
    const sourceAccount = await this.loadAccount(sourcePublicKey);

    // Fetch base fee with resilience (falls back to config on failure)
    const baseFee = await this.fetchBaseFee();

    // Build transaction
    const transaction = new TransactionBuilder(sourceAccount, {
      fee: baseFee,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: vaultPublicKey,
          asset: asset,
          amount: amount,
        })
      )
      .setTimeout(this.config.transactionTimeout)
      .build();

    return transaction.toXDR();
  }

  /**
   * Get circuit breaker metrics for monitoring.
   */
  getMetrics() {
    return this.circuitBreaker.getMetrics();
  }

  /**
   * Get current configuration.
   */
  getConfig(): Required<TransactionBuilderConfig> {
    return { ...this.config };
  }
}

/**
 * Singleton instance for application-wide use.
 */
let instance: StellarTransactionBuilder | null = null;

/**
 * Get or create the singleton transaction builder instance.
 */
export function getTransactionBuilder(config?: TransactionBuilderConfig): StellarTransactionBuilder {
  if (!instance) {
    instance = new StellarTransactionBuilder(config);
  }
  return instance;
}

/**
 * Reset the singleton instance (primarily for testing).
 */
export function resetTransactionBuilder(): void {
  instance = null;
}
