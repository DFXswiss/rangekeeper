import { Contract, BigNumber, Wallet, ContractTransaction, constants } from 'ethers';
import { getLogger } from '../util/logger';
import { getSwapRouterContract, getErc20Contract, ensureApproval } from '../chain/contracts';
import { withRetry } from '../util/retry';

export type WalletProvider = () => Wallet;

export class SwapExecutor {
  private readonly logger = getLogger();

  constructor(
    private readonly getWallet: WalletProvider,
    private readonly swapRouterAddress: string,
  ) {}

  private get wallet(): Wallet {
    return this.getWallet();
  }

  private get router(): Contract {
    return getSwapRouterContract(this.swapRouterAddress, this.wallet);
  }

  async approveTokens(token0Address: string, token1Address: string): Promise<void> {
    const w = this.wallet;
    const token0 = getErc20Contract(token0Address, w);
    const token1 = getErc20Contract(token1Address, w);

    await Promise.all([
      ensureApproval(token0, this.swapRouterAddress, w.address, constants.MaxUint256),
      ensureApproval(token1, this.swapRouterAddress, w.address, constants.MaxUint256),
    ]);

    this.logger.info('Token approvals confirmed for Swap Router');
  }

  async executeSwap(
    tokenIn: string,
    tokenOut: string,
    feeTier: number,
    amountIn: BigNumber,
    slippagePercent: number,
  ): Promise<BigNumber> {
    const w = this.wallet;
    const router = this.router;

    this.logger.info(
      { tokenIn, tokenOut, feeTier, amountIn: amountIn.toString(), slippagePercent },
      'Executing swap',
    );

    // For stablecoin pairs, we expect ~1:1 ratio, so min out is based on slippage
    const slippageMul = Math.floor((1 - slippagePercent / 100) * 10000);
    const amountOutMinimum = amountIn.mul(slippageMul).div(10000);

    const tx: ContractTransaction = await withRetry(
      () =>
        router.exactInputSingle({
          tokenIn,
          tokenOut,
          fee: feeTier,
          recipient: w.address,
          amountIn,
          amountOutMinimum,
          sqrtPriceLimitX96: 0,
        }),
      'swap',
    );

    const receipt = await tx.wait();
    if (receipt.status === 0) {
      throw new Error('Swap transaction reverted on-chain');
    }

    // Parse Transfer event from output token to get amountOut
    const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const transferLog = receipt.logs.find(
      (log: { topics: string[]; address: string }) =>
        log.topics[0] === transferTopic && log.address.toLowerCase() === tokenOut.toLowerCase(),
    );

    if (!transferLog) {
      this.logger.error({ txHash: receipt.transactionHash, logsCount: receipt.logs?.length }, 'Transfer event not found in swap receipt');
      throw new Error(`Swap succeeded but Transfer event not found for output token (tx: ${receipt.transactionHash})`);
    }

    const amountOut = BigNumber.from(transferLog.data);
    if (amountOut.isZero()) {
      throw new Error(`Swap returned amountOut=0 (tx: ${receipt.transactionHash})`);
    }

    this.logger.info(
      { amountIn: amountIn.toString(), amountOut: amountOut.toString(), gasUsed: receipt.gasUsed.toString() },
      'Swap completed',
    );

    return amountOut;
  }
}
