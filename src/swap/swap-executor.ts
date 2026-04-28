import { Contract, BigNumber, Wallet, ContractTransaction, constants } from 'ethers';
import { TickMath } from '@uniswap/v3-sdk';
import { getLogger } from '../util/logger';
import { getSwapRouterContract, getErc20Contract, ensureApproval } from '../chain/contracts';
import { withRetry, NonRetryableError } from '../util/retry';
import { NonceTracker } from '../chain/nonce-tracker';

export type WalletProvider = () => Wallet;

export interface SwapResult {
  amountOut: BigNumber;
  txHash: string;
}

export class SwapExecutor {
  private readonly logger = getLogger();

  constructor(
    private readonly getWallet: WalletProvider,
    private readonly swapRouterAddress: string,
    protected readonly nonceTracker?: NonceTracker,
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

    // Run approvals sequentially when using NonceTracker to avoid nonce conflicts
    if (this.nonceTracker) {
      await ensureApproval(token0, this.swapRouterAddress, w.address, constants.MaxUint256, this.nonceTracker);
      await ensureApproval(token1, this.swapRouterAddress, w.address, constants.MaxUint256, this.nonceTracker);
    } else {
      await Promise.all([
        ensureApproval(token0, this.swapRouterAddress, w.address, constants.MaxUint256),
        ensureApproval(token1, this.swapRouterAddress, w.address, constants.MaxUint256),
      ]);
    }

    this.logger.info('Token approvals confirmed for Swap Router');
  }

  async executeSwap(
    tokenIn: string,
    tokenOut: string,
    feeTier: number,
    amountIn: BigNumber,
    slippagePercent: number,
    currentTick?: number,
    decimalsIn?: number,
    decimalsOut?: number,
    tokenInIsToken0?: boolean,
  ): Promise<SwapResult> {
    const w = this.wallet;
    const router = this.router;

    this.logger.info({ tokenIn, tokenOut, feeTier, amountIn: amountIn.toString(), slippagePercent }, 'Executing swap');

    // Verify wallet has sufficient balance before submitting swap
    const tokenInContract = getErc20Contract(tokenIn, w);
    const balance: BigNumber = await tokenInContract.balanceOf(w.address);
    if (balance.lt(amountIn)) {
      throw new NonRetryableError(
        `Insufficient balance for swap: have ${balance.toString()} but need ${amountIn.toString()} of ${tokenIn}`,
      );
    }

    const slippageMul = Math.floor((1 - slippagePercent / 100) * 10000);
    const amountOutMinimum = this.computeAmountOutMinimum(
      amountIn,
      slippageMul,
      currentTick,
      decimalsIn,
      decimalsOut,
      tokenInIsToken0,
    );

    const sqrtPriceLimitX96 = this.computeSqrtPriceLimit(currentTick, slippagePercent, tokenInIsToken0);

    const nonceOverride = this.nonceTracker ? { nonce: this.nonceTracker.getNextNonce() } : {};
    const tx: ContractTransaction = await withRetry(
      () =>
        router.exactInputSingle(
          {
            tokenIn,
            tokenOut,
            fee: feeTier,
            recipient: w.address,
            amountIn,
            amountOutMinimum,
            sqrtPriceLimitX96,
          },
          nonceOverride,
        ),
      'swap',
    );

    const receipt = await this.waitAndConfirmNonce(tx);
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
      this.logger.error(
        { txHash: receipt.transactionHash, logsCount: receipt.logs?.length },
        'Transfer event not found in swap receipt',
      );
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

    return { amountOut, txHash: receipt.transactionHash };
  }

  protected computeAmountOutMinimum(
    amountIn: BigNumber,
    slippageMul: number,
    currentTick?: number,
    decimalsIn?: number,
    decimalsOut?: number,
    tokenInIsToken0?: boolean,
  ): BigNumber {
    // If price info is provided, compute price-aware minimum
    if (
      currentTick !== undefined &&
      decimalsIn !== undefined &&
      decimalsOut !== undefined &&
      tokenInIsToken0 !== undefined
    ) {
      try {
        const price = Math.pow(1.0001, currentTick);
        if (!Number.isFinite(price) || price <= 0) {
          throw new Error(`Invalid price from tick ${currentTick}`);
        }

        // Use scaled integer arithmetic: price scaled by 10^15
        const PRICE_PRECISION = 1e15;
        const priceScaled = Math.round(price * PRICE_PRECISION);
        if (!Number.isFinite(priceScaled) || priceScaled <= 0) {
          throw new Error(`Price scaling overflow for tick ${currentTick}`);
        }
        const priceBN = BigNumber.from(Math.floor(priceScaled).toString());
        const precisionBN = BigNumber.from(Math.floor(PRICE_PRECISION).toString());

        const absDiff = Math.abs(decimalsOut - decimalsIn);
        const decimalAdjust = absDiff > 0 ? BigNumber.from(10).pow(absDiff) : BigNumber.from(1);

        let expectedOut: BigNumber;
        if (tokenInIsToken0) {
          // token0→token1: expectedOut = amountIn * price * 10^(decOut-decIn)
          if (decimalsOut >= decimalsIn) {
            expectedOut = amountIn.mul(priceBN).mul(decimalAdjust).div(precisionBN);
          } else {
            expectedOut = amountIn.mul(priceBN).div(precisionBN).div(decimalAdjust);
          }
        } else {
          // token1→token0: expectedOut = amountIn / price * 10^(decOut-decIn)
          if (decimalsOut >= decimalsIn) {
            expectedOut = amountIn.mul(precisionBN).mul(decimalAdjust).div(priceBN);
          } else {
            expectedOut = amountIn.mul(precisionBN).div(priceBN).div(decimalAdjust);
          }
        }

        const result = expectedOut.mul(slippageMul).div(10000);
        if (result.gt(0)) {
          this.logger.debug(
            { expectedOut: expectedOut.toString(), amountOutMinimum: result.toString(), currentTick },
            'Price-aware amountOutMinimum computed',
          );
          return result;
        }
      } catch (err) {
        this.logger.warn({ err, currentTick }, 'Failed to compute price-aware amountOutMinimum, using 1:1 fallback');
      }
    }

    // Fallback: assume 1:1 ratio (safe for same-decimal stablecoin pairs)
    return amountIn.mul(slippageMul).div(10000);
  }

  private computeSqrtPriceLimit(
    currentTick?: number,
    slippagePercent?: number,
    tokenInIsToken0?: boolean,
  ): BigNumber {
    if (currentTick === undefined || slippagePercent === undefined || tokenInIsToken0 === undefined) {
      return BigNumber.from(0);
    }

    try {
      const slippageTicks = Math.ceil(Math.log(1 + slippagePercent / 100) / Math.log(1.0001));
      const limitTick = tokenInIsToken0
        ? Math.max(currentTick - slippageTicks, TickMath.MIN_TICK)
        : Math.min(currentTick + slippageTicks, TickMath.MAX_TICK);
      return BigNumber.from(TickMath.getSqrtRatioAtTick(limitTick).toString());
    } catch (err) {
      this.logger.warn({ err, currentTick }, 'Failed to compute sqrtPriceLimitX96, using 0 (no limit)');
      return BigNumber.from(0);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async waitAndConfirmNonce(tx: ContractTransaction): Promise<any> {
    try {
      const receipt = await tx.wait();
      this.nonceTracker?.confirmNonce();
      return receipt;
    } catch (err) {
      if (this.nonceTracker) {
        await this.nonceTracker.syncOnFailover();
      }
      throw err;
    }
  }
}
