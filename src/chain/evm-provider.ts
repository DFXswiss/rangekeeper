import { ethers, providers, Wallet } from 'ethers';
import { getLogger } from '../util/logger';

export type FailoverCallback = (fromUrl: string, toUrl: string, newProvider: providers.JsonRpcProvider) => void;

export class FailoverProvider {
  private readonly logger = getLogger();
  private readonly rpcUrls: string[];
  private currentIndex = 0;
  private provider: providers.JsonRpcProvider;
  private consecutiveErrors = 0;
  private readonly maxConsecutiveErrors: number;
  private onFailover?: FailoverCallback;

  constructor(rpcUrls: string[], maxConsecutiveErrors = 5) {
    if (rpcUrls.length === 0) {
      throw new Error('At least one RPC URL is required');
    }
    this.rpcUrls = rpcUrls;
    this.maxConsecutiveErrors = maxConsecutiveErrors;
    this.provider = new ethers.providers.JsonRpcProvider(rpcUrls[0]);
  }

  getProvider(): providers.JsonRpcProvider {
    return this.provider;
  }

  getCurrentUrl(): string {
    return this.rpcUrls[this.currentIndex];
  }

  setFailoverCallback(cb: FailoverCallback): void {
    this.onFailover = cb;
  }

  recordSuccess(): void {
    this.consecutiveErrors = 0;
  }

  recordError(): boolean {
    this.consecutiveErrors++;

    if (this.consecutiveErrors >= this.maxConsecutiveErrors && this.rpcUrls.length > 1) {
      return this.switchToNext();
    }

    return false;
  }

  private switchToNext(): boolean {
    const fromUrl = this.rpcUrls[this.currentIndex];
    const nextIndex = (this.currentIndex + 1) % this.rpcUrls.length;

    if (nextIndex === this.currentIndex) return false;

    this.currentIndex = nextIndex;
    const toUrl = this.rpcUrls[this.currentIndex];
    this.provider = new ethers.providers.JsonRpcProvider(toUrl);
    this.consecutiveErrors = 0;

    this.logger.warn(
      { from: fromUrl, to: toUrl, consecutiveErrors: this.maxConsecutiveErrors },
      'RPC failover: switched to backup provider',
    );

    if (this.onFailover) {
      this.onFailover(fromUrl, toUrl, this.provider);
    }

    return true;
  }
}

const providerCache = new Map<string, providers.JsonRpcProvider>();

export function getProvider(rpcUrl: string): providers.JsonRpcProvider {
  const cached = providerCache.get(rpcUrl);
  if (cached) return cached;

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  providerCache.set(rpcUrl, provider);
  return provider;
}

export function createFailoverProvider(primaryUrl: string, backupUrls: string[] = []): FailoverProvider {
  return new FailoverProvider([primaryUrl, ...backupUrls]);
}

export function getWallet(privateKey: string, provider: providers.JsonRpcProvider): Wallet {
  return new ethers.Wallet(privateKey, provider);
}

export async function verifyConnection(provider: providers.JsonRpcProvider): Promise<{ chainId: number; blockNumber: number }> {
  const logger = getLogger();
  const [network, blockNumber] = await Promise.all([provider.getNetwork(), provider.getBlockNumber()]);
  logger.info({ chainId: network.chainId, blockNumber }, 'Connected to chain');
  return { chainId: network.chainId, blockNumber };
}
