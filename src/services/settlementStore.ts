import { Settlement, SettlementStore } from '../types/developer.js';

export class InMemorySettlementStore implements SettlementStore {
  private settlements: Settlement[] = [];

  create(settlement: Settlement): void {
    this.settlements.push({
      ...settlement,
      completed_at: settlement.completed_at ?? null,
    });
  }

  updateStatus(id: string, status: Settlement['status'], txHash?: string | null): void {
    const s = this.settlements.find((s) => s.id === id);
    if (s) {
      s.status = status;
      if (txHash !== undefined) {
        s.tx_hash = txHash;
      }
      s.completed_at = status === 'completed' ? new Date().toISOString() : null;
    }
  }

  getDeveloperSettlements(developerId: string): Settlement[] {
    return this.settlements
      .filter((s) => s.developerId === developerId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }

  getPendingSettlements(): Settlement[] {
    return this.settlements
      .filter((s) => s.status === 'pending')
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  }

  /** Helper for tests */
  clear(): void {
    this.settlements = [];
  }
}

export function createSettlementStore(): InMemorySettlementStore {
  return new InMemorySettlementStore();
}
