import { Contract, BigNumber, Wallet, ContractTransaction } from 'ethers';
import { getLogger } from '../util/logger';
import { getSwapRouterContract, getErc20Contract, ensureApproval } from '../chain/contracts';
import { withRetry } from '../util/retry';

export class SwapExecutor {
  private readonly logger = getLogger();
  private readonly router: Contract;

  constructor(
    private readonly wallet: Wallet,
    private readonly swapRouterAddress: string,
  ) {
    this.router = getSwapRouterContract(swapRouterAddress, wallet);
  }

  async executeSwap(
    tokenIn: string,
    tokenOut: string,
    feeTier: number,
    amountIn: BigNumber,
    slippagePercent: number,
  ): Promise<BigNumber> {
    this.logger.info(
      { tokenIn, tokenOut, feeTier, amountIn: amountIn.toString(), slippagePercent },
      'Executing swap',
    );

    // Ensure approval
    const tokenInContract = getErc20Contract(tokenIn, this.wallet);
    await ensureApproval(tokenInContract, this.swapRouterAddress, this.wallet.address, amountIn);

    // For stablecoin pairs, we expect ~1:1 ratio, so min out is based on slippage
    const slippageMul = Math.floor((1 - slippagePercent / 100) * 10000);
    const amountOutMinimum = amountIn.mul(slippageMul).div(10000);

    const tx: ContractTransaction = await withRetry(
      () =>
        this.router.exactInputSingle({
          tokenIn,
          tokenOut,
          fee: feeTier,
          recipient: this.wallet.address,
          amountIn,
          amountOutMinimum,
          sqrtPriceLimitX96: 0,
        }),
      'swap',
    );

    const receipt = await tx.wait();

    // Parse Transfer event from output token to get amountOut
    const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const transferLog = receipt.logs.find(
      (log: { topics: string[]; address: string }) =>
        log.topics[0] === transferTopic && log.address.toLowerCase() === tokenOut.toLowerCase(),
    );

    const amountOut = transferLog ? BigNumber.from(transferLog.data) : BigNumber.from(0);

    this.logger.info(
      { amountIn: amountIn.toString(), amountOut: amountOut.toString(), gasUsed: receipt.gasUsed.toString() },
      'Swap completed',
    );

    return amountOut;
  }
}
