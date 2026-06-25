import { Settlement, SettlementStore } from '../types/developer.js';
import { ApiRegistry, UsageEvent, UsageStore } from '../types/gateway.js';
import { SorobanSettlementClient } from './sorobanSettlement.js';
import { randomUUID } from 'node:crypto';
import { config } from '../config/index.js';
import { calloraEvents } from '../events/event.emitter.js';
import {
  RETRIABLE_HTTP_STATUSES,
  TransientError,
  isTransientNetworkError,
  withRetry,
} from '../lib/retry.js';

export interface RevenueSettlementOptions {
  /** Minimum accumulated USDC to trigger a payout (default: 5.00) */
  minPayoutUsdc?: number;
  /** Maximum number of events to process per developer per batch (to avoid hitting transaction limits) */
  maxEventsPerBatch?: number;
  horizonUrl?: string;
  fetchImpl?: typeof fetch;
  horizonRequestTimeoutMs?: number;
  horizonMaxRetries?: number;
  horizonRetryBaseDelayMs?: number;
}

interface HorizonTransactionResponse {
  successful?: boolean;
}

export class RevenueSettlementService {
  private batchTail: Promise<void> = Promise.resolve();
  private reconcileTail: Promise<void> = Promise.resolve();

  constructor(
    private usageStore: UsageStore,
    private settlementStore: SettlementStore,
    private apiRegistry: ApiRegistry,
    private settlementClient: SorobanSettlementClient,
    private options: RevenueSettlementOptions = {},
  ) { }

  /**
   * Run a settlement batch.
   * 1. Finds all unsettled events with amount > 0.
   * 2. Resolves each event's API to its developerId.
   * 3. Groups by developer, applying max batch size.
   * 4. For each developer meeting min payout, creates a settlement + calls distribute().
   */
  async runBatch(): Promise<{ processed: number; settledAmount: number; errors: number }> {
    const previousBatch = this.batchTail.catch(() => undefined);
    let releaseBatch!: () => void;
    this.batchTail = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });

    await previousBatch;

    try {
      return await this.runBatchOnce();
    } finally {
      releaseBatch();
    }
  }

  private async runBatchOnce(): Promise<{ processed: number; settledAmount: number; errors: number }> {
    const unsettled = await this.usageStore.getUnsettledEvents();
    if (unsettled.length === 0) {
      return { processed: 0, settledAmount: 0, errors: 0 };
    }

    const minPayout = this.options.minPayoutUsdc ?? 5.0;
    const maxEvents = this.options.maxEventsPerBatch ?? 1000;

    // Group events by developerId
    const devEvents = new Map<string, UsageEvent[]>();

    for (const event of unsettled) {
      if (event.amountUsdc <= 0) continue;

      const apiEntry = this.apiRegistry.resolve(event.apiId);
      if (!apiEntry) {
        // Orphaned event, can't settle without knowing the developer
        continue;
      }

      const devId = apiEntry.developerId;
      const group = devEvents.get(devId) ?? [];

      // Enforce batch size limit per developer
      if (group.length < maxEvents) {
        group.push(event);
        devEvents.set(devId, group);
      }
    }

    let processed = 0;
    let settledAmount = 0;
    let errors = 0;

    for (const [developerId, events] of devEvents.entries()) {
      const totalAmount = events.reduce((sum, e) => sum + e.amountUsdc, 0);

      if (totalAmount < minPayout) {
        // Skip for now, let it accumulate for the next batch
        continue;
      }

      const settlementId = `stl_${randomUUID()}`;
      const eventIds = events.map((e) => e.id);

      // 1. Create pending settlement record in DB (idempotency start)
      const settlement: Settlement = {
        id: settlementId,
        developerId,
        amount: totalAmount,
        status: 'pending',
        tx_hash: null,
        created_at: new Date().toISOString(),
      };
      try {
        await this.settlementStore.create(settlement);
      } catch (error) {
        errors++;
        console.error(
          `Settlement ${settlementId} failed for dev ${developerId}:`,
          this.getErrorMessage(error)
        );
        continue;
      }

      // 2. Call contract
      // Note: in a real system we would use the developer's registered Soroban address here.
      // For this mock, we just use the developerId as the address string.
      let result;

      try {
        result = await this.settlementClient.distribute(developerId, totalAmount);
      } catch (error) {
        result = {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown settlement client failure',
        };
      }

      // 3. Update settlement status and events, then emit after DB commit
      if (result.success && result.txHash) {
        try {
          await this.settlementStore.updateStatus(settlementId, 'completed', result.txHash);
          await this.usageStore.markAsSettled(eventIds, settlementId);

          await this.emitSettlementCompleted(
            settlementId,
            developerId,
            totalAmount,
            result.txHash,
          );

          processed += events.length;
          settledAmount += totalAmount;
        } catch (error) {
          errors++;
          await this.recordFailedSettlement(
            settlementId,
            developerId,
            `Finalization failed after payout: ${this.getErrorMessage(error)}`,
            true,
          );
        }
      } else {
        // Failed: record failure, do NOT mark events as settled so they retry next batch
        errors++;
        await this.recordFailedSettlement(settlementId, developerId, result.error);
      }
    }

    return { processed, settledAmount, errors };
  }

  /**
   * Poll Horizon for pending settlements that already have a transaction hash.
   * Status updates are persisted before any domain events are emitted.
   */
  async reconcilePendingSettlements(): Promise<{
    checked: number;
    completed: number;
    failed: number;
    errors: number;
  }> {
    const previousReconcile = this.reconcileTail.catch(() => undefined);
    let releaseReconcile!: () => void;
    this.reconcileTail = new Promise<void>((resolve) => {
      releaseReconcile = resolve;
    });

    await previousReconcile;

    try {
      return await this.reconcilePendingSettlementsOnce();
    } finally {
      releaseReconcile();
    }
  }

  private async reconcilePendingSettlementsOnce(): Promise<{
    checked: number;
    completed: number;
    failed: number;
    errors: number;
  }> {
    const pending = await this.settlementStore.getPendingSettlements();
    let checked = 0;
    let completed = 0;
    let failed = 0;
    let errors = 0;

    for (const settlement of pending) {
      if (!settlement.tx_hash) {
        continue;
      }

      checked++;
      const outcome = await this.resolveHorizonTransactionOutcome(settlement.tx_hash);

      if (outcome === 'retry_exhausted') {
        errors++;
        continue;
      }

      try {
        if (outcome === 'completed') {
          await this.settlementStore.updateStatus(settlement.id, 'completed', settlement.tx_hash);
          await this.emitSettlementCompleted(
            settlement.id,
            settlement.developerId,
            settlement.amount,
            settlement.tx_hash,
          );
          completed++;
        } else {
          await this.settlementStore.updateStatus(settlement.id, 'failed', settlement.tx_hash);
          failed++;
        }
      } catch (error) {
        errors++;
        console.error(
          `Settlement ${settlement.id} reconciliation failed for dev ${settlement.developerId}:`,
          this.getErrorMessage(error),
        );
      }
    }

    return { checked, completed, failed, errors };
  }

  private async resolveHorizonTransactionOutcome(
    txHash: string,
  ): Promise<'completed' | 'failed' | 'retry_exhausted'> {
    const horizonUrl = this.options.horizonUrl ?? config.stellar.horizonUrl;
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const timeoutMs = this.options.horizonRequestTimeoutMs ?? 10_000;
    const maxAttempts = (this.options.horizonMaxRetries ?? 3) + 1;
    const baseDelayMs = this.options.horizonRetryBaseDelayMs ?? 500;
    const url = new URL(`transactions/${encodeURIComponent(txHash)}`, horizonUrl).toString();

    try {
      const resolution = await withRetry(
        async (): Promise<{ terminal: true; outcome: 'completed' | 'failed' }> => {
          let response: Response;

          try {
            response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
          } catch (error) {
            if (isTransientNetworkError(error)) {
              throw error;
            }

            throw error;
          }

          if (response.status === 404) {
            return { terminal: true, outcome: 'failed' };
          }

          if (!response.ok) {
            if (RETRIABLE_HTTP_STATUSES.has(response.status)) {
              throw new TransientError(`Horizon HTTP ${response.status}`);
            }

            throw new Error(`Horizon HTTP ${response.status}`);
          }

          const body = (await response.json()) as HorizonTransactionResponse;
          return {
            terminal: true,
            outcome: body.successful ? 'completed' : 'failed',
          };
        },
        {
          maxAttempts,
          baseDelayMs,
          jitter: false,
          shouldRetry: (error) => isTransientNetworkError(error) || error instanceof TransientError,
        },
      );

      return resolution.outcome;
    } catch {
      return 'retry_exhausted';
    }
  }

  private async recordFailedSettlement(
    settlementId: string,
    developerId: string,
    errorMessage?: string,
    clearTxHash = false,
  ): Promise<void> {
    try {
      await this.settlementStore.updateStatus(
        settlementId,
        'failed',
        clearTxHash ? null : undefined,
      );
    } catch (statusError) {
      console.error(
        `Settlement ${settlementId} failed for dev ${developerId} and could not persist failure status:`,
        this.getErrorMessage(statusError)
      );
    }

    console.error(
      `Settlement ${settlementId} failed for dev ${developerId}:`,
      errorMessage ?? 'Unknown settlement failure'
    );
  }

  /**
   * Notify subscribers only after settlement rows and usage events are persisted.
   * Emission is fire-and-forget; webhook delivery failures do not roll back payouts.
   */
  private async emitSettlementCompleted(
    settlementId: string,
    developerId: string,
    amountUsdc: number,
    txHash: string,
  ): Promise<void> {
    const settlements = await this.settlementStore.getDeveloperSettlements(developerId);
    const settlement = settlements.find((entry) => entry.id === settlementId);
    const settledAt = settlement?.completed_at ?? new Date().toISOString();

    calloraEvents.emit('settlement_completed', developerId, {
      settlementId,
      amount: amountUsdc.toFixed(7),
      asset: 'USDC',
      txHash,
      settledAt,
    });
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim()) {
      return error.message;
    }

    if (typeof error === 'string' && error.trim()) {
      return error;
    }

    return 'Unknown settlement failure';
  }
}
