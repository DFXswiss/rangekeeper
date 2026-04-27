import { providers, utils } from 'ethers';
import { getLogger } from '../util/logger';

export interface GasInfo {
  gasPriceGwei: number;
  maxFeePerGasGwei?: number;
  maxPriorityFeePerGasGwei?: number;
  isEip1559: boolean;
}

const RING_BUFFER_SIZE = 20;

export class GasOracle {
  private readonly logger = getLogger();
  private baselineGasPrice: number | undefined;
  private readonly gasPriceBuffer: number[] = [];

  async getGasInfo(provider: providers.JsonRpcProvider): Promise<GasInfo> {
    try {
      const feeData = await provider.getFeeData();

      if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
        const info: GasInfo = {
          gasPriceGwei: parseFloat(utils.formatUnits(feeData.maxFeePerGas, 'gwei')),
          maxFeePerGasGwei: parseFloat(utils.formatUnits(feeData.maxFeePerGas, 'gwei')),
          maxPriorityFeePerGasGwei: parseFloat(utils.formatUnits(feeData.maxPriorityFeePerGas, 'gwei')),
          isEip1559: true,
        };
        this.updateBaseline(info.gasPriceGwei);
        return info;
      }

      const gasPrice = feeData.gasPrice ?? (await provider.getGasPrice());
      const info: GasInfo = {
        gasPriceGwei: parseFloat(utils.formatUnits(gasPrice, 'gwei')),
        isEip1559: false,
      };
      this.updateBaseline(info.gasPriceGwei);
      return info;
    } catch (err) {
      this.logger.error({ err }, 'Failed to fetch gas info');
      throw err;
    }
  }

  private updateBaseline(currentGwei: number): void {
    this.gasPriceBuffer.push(currentGwei);
    if (this.gasPriceBuffer.length > RING_BUFFER_SIZE) {
      this.gasPriceBuffer.shift();
    }

    // Use median of the ring buffer as baseline
    const sorted = [...this.gasPriceBuffer].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    this.baselineGasPrice = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }

  isGasSpike(currentGwei: number, multiplier = 10): boolean {
    if (!this.baselineGasPrice) return false;
    return currentGwei > this.baselineGasPrice * multiplier;
  }
}

export function estimateGasCostUsd(gasUsed: number, gasPriceGwei: number, ethPriceUsd: number): number {
  const gasCostEth = (gasUsed * gasPriceGwei) / 1e9;
  return gasCostEth * ethPriceUsd;
}
