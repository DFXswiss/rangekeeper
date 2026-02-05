import { ethers, providers, Wallet } from 'ethers';
import { getLogger } from '../util/logger';

const providerCache = new Map<string, providers.JsonRpcProvider>();

export function getProvider(rpcUrl: string): providers.JsonRpcProvider {
  const cached = providerCache.get(rpcUrl);
  if (cached) return cached;

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  providerCache.set(rpcUrl, provider);
  return provider;
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
