import type { Request, Response } from 'express';
import type { AuthenticatedLocals } from '../middleware/requireAuth.js';
import type { VaultRepository } from '../repositories/vaultRepository.js';
import { parseNetworkWithDefault } from '../validators/networkSchema.js';

export class VaultController {
  constructor(private readonly vaultRepository: VaultRepository) { }

  /**
   * Returns the authenticated user's vault balance for the requested Stellar network.
   * Accepted query values for `network` are `testnet` and `mainnet`.
   * When omitted, `network` defaults to `testnet`.
   */
  async getBalance(
    req: Request,
    res: Response<unknown, AuthenticatedLocals>
  ): Promise<void> {
    try {
      const user = res.locals.authenticatedUser;
      if (!user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const network = parseNetworkWithDefault(req.query);

      const vault = await this.vaultRepository.findByUserId(user.id, network);
      if (!vault) {
        res.status(404).json({ error: `Vault not found for user on network '${network}'. Please create a vault first.` });
        return;
      }

      // Format balance from stroops (bigint) to USDC string (7 decimals)
      const balanceUsdc = this.formatStroopsToUsdc(vault.balanceSnapshot);

      res.status(200).json({
        balance_usdc: balanceUsdc,
        contractId: vault.contractId,
        network: vault.network,
        lastSyncedAt: vault.lastSyncedAt ? vault.lastSyncedAt.toISOString() : null
      });
    } catch (error) {
      console.error('Failed to get vault balance:', error);
      res.status(500).json({ error: 'Failed to retrieve vault balance' });
    }
  }

  private formatStroopsToUsdc(stroops: bigint): string {
    const isNegative = stroops < 0n;
    const absStroops = isNegative ? -stroops : stroops;

    // Pad with leading zeros if less than 1 USDC (10,000,000 stroops)
    const paddedStr = absStroops.toString().padStart(8, '0');

    // Insert decimal point 7 places from the right
    const decimalIndex = paddedStr.length - 7;
    const result = `${paddedStr.slice(0, decimalIndex)}.${paddedStr.slice(decimalIndex)}`;

    return isNegative ? `-${result}` : result;
  }
}
