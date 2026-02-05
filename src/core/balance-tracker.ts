import { BigNumber, Wallet } from 'ethers';
import { getLogger } from '../util/logger';
import { getErc20Contract } from '../chain/contracts';
import { formatTokenAmount } from '../util/format';

export type WalletProvider = () => Wallet;

export interface TokenBalance {
  symbol: string;
  address: string;
  balance: BigNumber;
  decimals: number;
  formatted: string;
}

export interface PortfolioSnapshot {
  timestamp: number;
  token0Balance: TokenBalance;
  token1Balance: TokenBalance;
  positionValue0?: BigNumber;
  positionValue1?: BigNumber;
  totalValueUsd?: number;
}

export class BalanceTracker {
  private readonly logger = getLogger();
  private initialValueUsd?: number;
  private snapshots: PortfolioSnapshot[] = [];

  constructor(private readonly getWallet: WalletProvider) {}

  private get wallet(): Wallet {
    return this.getWallet();
  }

  async getTokenBalance(tokenAddress: string, symbol: string, decimals: number): Promise<TokenBalance> {
    const w = this.wallet;
    const contract = getErc20Contract(tokenAddress, w);
    const balance: BigNumber = await contract.balanceOf(w.address);

    return {
      symbol,
      address: tokenAddress,
      balance,
      decimals,
      formatted: formatTokenAmount(balance, decimals),
    };
  }

  async takeSnapshot(
    token0: { address: string; symbol: string; decimals: number },
    token1: { address: string; symbol: string; decimals: number },
  ): Promise<PortfolioSnapshot> {
    const [token0Balance, token1Balance] = await Promise.all([
      this.getTokenBalance(token0.address, token0.symbol, token0.decimals),
      this.getTokenBalance(token1.address, token1.symbol, token1.decimals),
    ]);

    const snapshot: PortfolioSnapshot = {
      timestamp: Date.now(),
      token0Balance,
      token1Balance,
    };

    this.snapshots.push(snapshot);
    this.logger.info(
      {
        token0: `${token0Balance.formatted} ${token0.symbol}`,
        token1: `${token1Balance.formatted} ${token1.symbol}`,
      },
      'Balance snapshot',
    );

    return snapshot;
  }

  setInitialValue(usd: number): void {
    this.initialValueUsd = usd;
    this.logger.info({ initialValueUsd: usd }, 'Set initial portfolio value');
  }

  getInitialValue(): number | undefined {
    return this.initialValueUsd;
  }

  getLossPercent(currentValueUsd: number): number | undefined {
    if (!this.initialValueUsd) return undefined;
    return ((this.initialValueUsd - currentValueUsd) / this.initialValueUsd) * 100;
  }

  getLastSnapshot(): PortfolioSnapshot | undefined {
    return this.snapshots[this.snapshots.length - 1];
  }
}
