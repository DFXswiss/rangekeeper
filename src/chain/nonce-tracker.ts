import { providers } from 'ethers';
import { getLogger } from '../util/logger';

export class NonceTracker {
  private readonly logger = getLogger();
  private currentNonce: number | undefined;

  constructor(
    private readonly walletAddress: string,
    private readonly getProvider: () => providers.JsonRpcProvider,
  ) {}

  async initialize(persistedNonce?: number): Promise<void> {
    const onChainNonce = await this.getProvider().getTransactionCount(this.walletAddress, 'latest');
    this.currentNonce = persistedNonce !== undefined
      ? Math.max(persistedNonce, onChainNonce)
      : onChainNonce;
    this.logger.info({ walletAddress: this.walletAddress, nonce: this.currentNonce, persistedNonce, onChainNonce }, 'Nonce tracker initialized');
  }

  getNextNonce(): number {
    if (this.currentNonce === undefined) {
      throw new Error('NonceTracker not initialized');
    }
    return this.currentNonce;
  }

  confirmNonce(): void {
    if (this.currentNonce === undefined) {
      throw new Error('NonceTracker not initialized');
    }
    this.currentNonce++;
  }

  getCurrentNonce(): number | undefined {
    return this.currentNonce;
  }

  async syncOnFailover(): Promise<void> {
    const onChainNonce = await this.getProvider().getTransactionCount(this.walletAddress, 'latest');
    this.currentNonce = Math.max(this.currentNonce ?? 0, onChainNonce);
    this.logger.info({ walletAddress: this.walletAddress, nonce: this.currentNonce, onChainNonce }, 'Nonce synced on failover');
  }
}
