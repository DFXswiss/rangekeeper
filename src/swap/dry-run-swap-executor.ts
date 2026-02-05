import { BigNumber } from 'ethers';
import { getLogger } from '../util/logger';
import { SwapExecutor, WalletProvider } from './swap-executor';

export class DryRunSwapExecutor extends SwapExecutor {
  private readonly dryLogger = getLogger();

  constructor(getWallet: WalletProvider, swapRouterAddress: string) {
    super(getWallet, swapRouterAddress);
  }

  async approveTokens(_token0Address: string, _token1Address: string): Promise<void> {
    this.dryLogger.info('[DRY RUN] Skipping token approvals for Swap Router');
  }

  async executeSwap(
    tokenIn: string,
    tokenOut: string,
    feeTier: number,
    amountIn: BigNumber,
    _slippagePercent: number,
  ): Promise<BigNumber> {
    const amountOut = amountIn.mul(1_000_000 - feeTier).div(1_000_000);

    this.dryLogger.info(
      {
        tokenIn,
        tokenOut,
        feeTier,
        amountIn: amountIn.toString(),
        amountOut: amountOut.toString(),
      },
      '[DRY RUN] Simulated swap (fee deducted)',
    );

    return amountOut;
  }
}
