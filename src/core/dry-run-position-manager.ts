import { BigNumber } from 'ethers';
import { getLogger } from '../util/logger';
import { PositionManager, MintParams, MintResult, RemoveResult, PositionInfo, WalletProvider } from './position-manager';

interface VirtualPosition {
  tokenId: BigNumber;
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: BigNumber;
  amount0: BigNumber;
  amount1: BigNumber;
}

const VIRTUAL_TOKEN_ID_START = 900_000_000;

export class DryRunPositionManager extends PositionManager {
  private readonly dryLogger = getLogger();
  private readonly virtualPositions = new Map<string, VirtualPosition>();
  private nextTokenId = VIRTUAL_TOKEN_ID_START;

  constructor(getWallet: WalletProvider, nftManagerAddress: string) {
    super(getWallet, nftManagerAddress);
  }

  async approveTokens(_token0Address: string, _token1Address: string): Promise<void> {
    this.dryLogger.info('[DRY RUN] Skipping token approvals for NFT Manager');
  }

  async mint(params: MintParams): Promise<MintResult> {
    const tokenId = BigNumber.from(this.nextTokenId++);
    const liquidity = params.amount0Desired.add(params.amount1Desired);

    const virtualPos: VirtualPosition = {
      tokenId,
      token0: params.token0,
      token1: params.token1,
      fee: params.fee,
      tickLower: params.tickLower,
      tickUpper: params.tickUpper,
      liquidity,
      amount0: params.amount0Desired,
      amount1: params.amount1Desired,
    };

    this.virtualPositions.set(tokenId.toString(), virtualPos);

    this.dryLogger.info(
      {
        tokenId: tokenId.toString(),
        tickLower: params.tickLower,
        tickUpper: params.tickUpper,
        amount0: params.amount0Desired.toString(),
        amount1: params.amount1Desired.toString(),
      },
      '[DRY RUN] Virtual position minted',
    );

    return {
      tokenId,
      liquidity,
      amount0: params.amount0Desired,
      amount1: params.amount1Desired,
      txHash: `dry-run-mint-${tokenId.toString()}`,
    };
  }

  async removePosition(tokenId: BigNumber, _liquidity: BigNumber, _slippagePercent: number): Promise<RemoveResult> {
    const key = tokenId.toString();
    const virtualPos = this.virtualPositions.get(key);

    if (virtualPos) {
      this.virtualPositions.delete(key);

      this.dryLogger.info(
        { tokenId: key },
        '[DRY RUN] Virtual position removed',
      );

      return {
        amount0: virtualPos.amount0,
        amount1: virtualPos.amount1,
        fee0: BigNumber.from(0),
        fee1: BigNumber.from(0),
        txHashes: {
          decreaseLiquidity: `dry-run-decrease-${key}`,
          collect: `dry-run-collect-${key}`,
          burn: `dry-run-burn-${key}`,
        },
      };
    }

    // On-chain position — simulate removal by reading its state
    this.dryLogger.info(
      { tokenId: key },
      '[DRY RUN] Simulating removal of on-chain position',
    );

    const pos = await super.getPosition(tokenId);
    return {
      amount0: pos.tokensOwed0,
      amount1: pos.tokensOwed1,
      fee0: BigNumber.from(0),
      fee1: BigNumber.from(0),
      txHashes: {
        decreaseLiquidity: `dry-run-decrease-${key}`,
        collect: `dry-run-collect-${key}`,
        burn: `dry-run-burn-${key}`,
      },
    };
  }

  async getPosition(tokenId: BigNumber): Promise<PositionInfo> {
    const key = tokenId.toString();
    const virtualPos = this.virtualPositions.get(key);

    if (virtualPos) {
      return {
        tokenId: virtualPos.tokenId,
        token0: virtualPos.token0,
        token1: virtualPos.token1,
        fee: virtualPos.fee,
        tickLower: virtualPos.tickLower,
        tickUpper: virtualPos.tickUpper,
        liquidity: virtualPos.liquidity,
        tokensOwed0: BigNumber.from(0),
        tokensOwed1: BigNumber.from(0),
      };
    }

    return super.getPosition(tokenId);
  }

  getVirtualPositions(): VirtualPosition[] {
    return Array.from(this.virtualPositions.values());
  }
}
