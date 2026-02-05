import { providers, utils } from 'ethers';
import { getLogger } from '../util/logger';

export interface GasInfo {
  gasPriceGwei: number;
  maxFeePerGasGwei?: number;
  maxPriorityFeePerGasGwei?: number;
  isEip1559: boolean;
}

export class GasOracle {
  private readonly logger = getLogger();
  private baselineGasPrice: number | undefined;

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
    if (!this.baselineGasPrice) {
      this.baselineGasPrice = currentGwei;
    } else {
      this.baselineGasPrice = this.baselineGasPrice * 0.95 + currentGwei * 0.05;
    }
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
