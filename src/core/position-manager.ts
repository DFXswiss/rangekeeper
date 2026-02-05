import { Contract, BigNumber, Wallet, constants, ContractTransaction } from 'ethers';
import { getLogger } from '../util/logger';
import { getNftManagerContract, getErc20Contract, ensureApproval } from '../chain/contracts';
import { withRetry } from '../util/retry';

export type WalletProvider = () => Wallet;

export interface MintParams {
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  amount0Desired: BigNumber;
  amount1Desired: BigNumber;
  slippagePercent: number;
  recipient: string;
}

export interface MintResult {
  tokenId: BigNumber;
  liquidity: BigNumber;
  amount0: BigNumber;
  amount1: BigNumber;
}

export interface RemoveResult {
  amount0: BigNumber;
  amount1: BigNumber;
  fee0: BigNumber;
  fee1: BigNumber;
}

export interface PositionInfo {
  tokenId: BigNumber;
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: BigNumber;
  tokensOwed0: BigNumber;
  tokensOwed1: BigNumber;
}

export class PositionManager {
  private readonly logger = getLogger();

  constructor(
    private readonly getWallet: WalletProvider,
    private readonly nftManagerAddress: string,
  ) {}

  private get wallet(): Wallet {
    return this.getWallet();
  }

  private get nftManager(): Contract {
    return getNftManagerContract(this.nftManagerAddress, this.wallet);
  }

  async approveTokens(token0Address: string, token1Address: string): Promise<void> {
    const w = this.wallet;
    const token0 = getErc20Contract(token0Address, w);
    const token1 = getErc20Contract(token1Address, w);

    await Promise.all([
      ensureApproval(token0, this.nftManagerAddress, w.address, constants.MaxUint256),
      ensureApproval(token1, this.nftManagerAddress, w.address, constants.MaxUint256),
    ]);

    this.logger.info('Token approvals confirmed for NFT Manager');
  }

  async mint(params: MintParams): Promise<MintResult> {
    const slippageMul = 1 - params.slippagePercent / 100;
    const amount0Min = params.amount0Desired.mul(Math.floor(slippageMul * 10000)).div(10000);
    const amount1Min = params.amount1Desired.mul(Math.floor(slippageMul * 10000)).div(10000);
    const deadline = Math.floor(Date.now() / 1000) + 300; // 5 min

    this.logger.info(
      {
        tickLower: params.tickLower,
        tickUpper: params.tickUpper,
        amount0Desired: params.amount0Desired.toString(),
        amount1Desired: params.amount1Desired.toString(),
      },
      'Minting new position',
    );

    const nftManager = this.nftManager;
    const tx: ContractTransaction = await withRetry(
      () =>
        nftManager.mint({
          token0: params.token0,
          token1: params.token1,
          fee: params.fee,
          tickLower: params.tickLower,
          tickUpper: params.tickUpper,
          amount0Desired: params.amount0Desired,
          amount1Desired: params.amount1Desired,
          amount0Min,
          amount1Min,
          recipient: params.recipient,
          deadline,
        }),
      'mint',
    );

    const receipt = await tx.wait();
    if (receipt.status === 0) {
      throw new Error('Mint transaction reverted on-chain');
    }

    const event = receipt.events?.find((e: { event?: string }) => e.event === 'IncreaseLiquidity');
    if (!event?.args) {
      this.logger.error({ txHash: receipt.transactionHash, logs: receipt.logs?.length }, 'IncreaseLiquidity event not found in mint receipt');
      throw new Error(`Mint succeeded but IncreaseLiquidity event not found (tx: ${receipt.transactionHash})`);
    }

    const result: MintResult = {
      tokenId: event.args.tokenId,
      liquidity: event.args.liquidity,
      amount0: event.args.amount0,
      amount1: event.args.amount1,
    };

    if (result.tokenId.isZero()) {
      throw new Error(`Mint returned tokenId=0 (tx: ${receipt.transactionHash})`);
    }

    this.logger.info(
      { tokenId: result.tokenId.toString(), liquidity: result.liquidity.toString() },
      'Position minted successfully',
    );

    return result;
  }

  async removePosition(tokenId: BigNumber, liquidity: BigNumber, slippagePercent: number): Promise<RemoveResult> {
    const deadline = Math.floor(Date.now() / 1000) + 300;
    const w = this.wallet;
    const nftManager = this.nftManager;

    this.logger.info({ tokenId: tokenId.toString(), liquidity: liquidity.toString(), slippagePercent }, 'Removing position');

    // Query expected amounts to calculate slippage-protected minimums
    const amounts = await nftManager.callStatic.decreaseLiquidity({
      tokenId,
      liquidity,
      amount0Min: 0,
      amount1Min: 0,
      deadline,
    });
    const slippageMul = Math.floor((1 - slippagePercent / 100) * 10000);
    const amount0Min = BigNumber.from(amounts.amount0).mul(slippageMul).div(10000);
    const amount1Min = BigNumber.from(amounts.amount1).mul(slippageMul).div(10000);

    // Step 1: Decrease liquidity with slippage protection
    const decreaseTx: ContractTransaction = await withRetry(
      () =>
        nftManager.decreaseLiquidity({
          tokenId,
          liquidity,
          amount0Min,
          amount1Min,
          deadline,
        }),
      'decreaseLiquidity',
    );
    const decreaseReceipt = await decreaseTx.wait();
    if (decreaseReceipt.status === 0) {
      throw new Error('decreaseLiquidity transaction reverted on-chain');
    }
    const decreaseEvent = decreaseReceipt.events?.find((e: { event?: string }) => e.event === 'DecreaseLiquidity');
    if (!decreaseEvent?.args) {
      this.logger.error({ txHash: decreaseReceipt.transactionHash }, 'DecreaseLiquidity event not found');
      throw new Error(`DecreaseLiquidity event not found (tx: ${decreaseReceipt.transactionHash})`);
    }

    // Step 2: Collect all tokens (including fees)
    const maxUint128 = BigNumber.from(2).pow(128).sub(1);
    const collectTx: ContractTransaction = await withRetry(
      () =>
        nftManager.collect({
          tokenId,
          recipient: w.address,
          amount0Max: maxUint128,
          amount1Max: maxUint128,
        }),
      'collect',
    );
    const collectReceipt = await collectTx.wait();
    if (collectReceipt.status === 0) {
      throw new Error('collect transaction reverted on-chain');
    }
    const collectEvent = collectReceipt.events?.find((e: { event?: string }) => e.event === 'Collect');
    if (!collectEvent?.args) {
      this.logger.error({ txHash: collectReceipt.transactionHash }, 'Collect event not found');
      throw new Error(`Collect event not found (tx: ${collectReceipt.transactionHash})`);
    }

    const principalAmount0: BigNumber = decreaseEvent.args.amount0;
    const principalAmount1: BigNumber = decreaseEvent.args.amount1;
    const totalAmount0: BigNumber = collectEvent.args.amount0;
    const totalAmount1: BigNumber = collectEvent.args.amount1;

    // Step 3: Burn the NFT
    const burnTx: ContractTransaction = await withRetry(() => nftManager.burn(tokenId), 'burn');
    const burnReceipt = await burnTx.wait();
    if (burnReceipt.status === 0) {
      throw new Error('burn transaction reverted on-chain');
    }

    const result: RemoveResult = {
      amount0: principalAmount0,
      amount1: principalAmount1,
      fee0: totalAmount0.sub(principalAmount0),
      fee1: totalAmount1.sub(principalAmount1),
    };

    this.logger.info(
      {
        tokenId: tokenId.toString(),
        amount0: result.amount0.toString(),
        amount1: result.amount1.toString(),
        fee0: result.fee0.toString(),
        fee1: result.fee1.toString(),
      },
      'Position removed successfully',
    );

    return result;
  }

  async getPosition(tokenId: BigNumber): Promise<PositionInfo> {
    const nftManager = this.nftManager;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pos: any = await withRetry(() => nftManager.positions(tokenId), 'getPosition');

    return {
      tokenId,
      token0: pos.token0,
      token1: pos.token1,
      fee: pos.fee,
      tickLower: pos.tickLower,
      tickUpper: pos.tickUpper,
      liquidity: pos.liquidity,
      tokensOwed0: pos.tokensOwed0,
      tokensOwed1: pos.tokensOwed1,
    };
  }

  async findExistingPositions(
    ownerAddress: string,
    token0: string,
    token1: string,
    fee: number,
  ): Promise<PositionInfo[]> {
    const nftManager = this.nftManager;
    const balance: BigNumber = await nftManager.balanceOf(ownerAddress);
    const positions: PositionInfo[] = [];

    for (let i = 0; i < balance.toNumber(); i++) {
      const tokenId: BigNumber = await nftManager.tokenOfOwnerByIndex(ownerAddress, i);
      const pos = await this.getPosition(tokenId);

      if (
        pos.token0.toLowerCase() === token0.toLowerCase() &&
        pos.token1.toLowerCase() === token1.toLowerCase() &&
        pos.fee === fee
      ) {
        positions.push(pos);
      }
    }

    return positions;
  }
}
