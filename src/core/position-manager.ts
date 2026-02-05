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
    const event = receipt.events?.find((e: { event?: string }) => e.event === 'IncreaseLiquidity');

    const result: MintResult = {
      tokenId: event?.args?.tokenId ?? BigNumber.from(0),
      liquidity: event?.args?.liquidity ?? BigNumber.from(0),
      amount0: event?.args?.amount0 ?? BigNumber.from(0),
      amount1: event?.args?.amount1 ?? BigNumber.from(0),
    };

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

    this.logger.info({ tokenId: tokenId.toString(), liquidity: liquidity.toString() }, 'Removing position');

    // Step 1: Decrease liquidity
    const decreaseTx: ContractTransaction = await withRetry(
      () =>
        nftManager.decreaseLiquidity({
          tokenId,
          liquidity,
          amount0Min: 0,
          amount1Min: 0,
          deadline,
        }),
      'decreaseLiquidity',
    );
    const decreaseReceipt = await decreaseTx.wait();
    const decreaseEvent = decreaseReceipt.events?.find((e: { event?: string }) => e.event === 'DecreaseLiquidity');

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
    const collectEvent = collectReceipt.events?.find((e: { event?: string }) => e.event === 'Collect');

    const principalAmount0 = decreaseEvent?.args?.amount0 ?? BigNumber.from(0);
    const principalAmount1 = decreaseEvent?.args?.amount1 ?? BigNumber.from(0);
    const totalAmount0 = collectEvent?.args?.amount0 ?? BigNumber.from(0);
    const totalAmount1 = collectEvent?.args?.amount1 ?? BigNumber.from(0);

    // Step 3: Burn the NFT
    const burnTx: ContractTransaction = await withRetry(() => nftManager.burn(tokenId), 'burn');
    await burnTx.wait();

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
