import { BigNumber } from 'ethers';

export interface Band {
  index: number;
  tokenId: BigNumber;
  tickLower: number;
  tickUpper: number;
}

export type TriggerDirection = 'lower' | 'upper';

export class BandManager {
  private bands: Band[] = [];
  private bandTickWidth: number = 0;

  setBands(bands: Band[], bandTickWidth: number): void {
    this.bands = [...bands].sort((a, b) => a.tickLower - b.tickLower);
    this.bandTickWidth = bandTickWidth;
  }

  getBands(): Band[] {
    return [...this.bands];
  }

  getBandCount(): number {
    return this.bands.length;
  }

  getBandTickWidth(): number {
    return this.bandTickWidth;
  }

  getBandIndexForTick(tick: number): number {
    for (let i = 0; i < this.bands.length; i++) {
      if (tick >= this.bands[i].tickLower && tick < this.bands[i].tickUpper) {
        return i;
      }
    }
    return -1;
  }

  isInSafeZone(tick: number): boolean {
    const idx = this.getBandIndexForTick(tick);
    // Safe zone: middle bands (index 2, 3, 4 for 7 bands)
    const count = this.bands.length;
    const safeStart = Math.floor(count / 2) - 1; // 2
    const safeEnd = Math.floor(count / 2) + 1;   // 4
    return idx >= safeStart && idx <= safeEnd;
  }

  getTriggerDirection(tick: number): TriggerDirection | null {
    const idx = this.getBandIndexForTick(tick);
    if (idx === -1) {
      // Price outside all bands — determine direction by comparing to edges
      if (tick < this.bands[0].tickLower) return 'lower';
      if (tick >= this.bands[this.bands.length - 1].tickUpper) return 'upper';
      return null;
    }
    // Trigger when price enters band index 1 (lower trigger) or index N-2 (upper trigger)
    if (idx <= 1) return 'lower';
    if (idx >= this.bands.length - 2) return 'upper';
    return null;
  }

  getBandToDissolve(direction: TriggerDirection): Band {
    if (direction === 'lower') {
      // Price going down → dissolve highest band
      return this.bands[this.bands.length - 1];
    }
    // Price going up → dissolve lowest band
    return this.bands[0];
  }

  getNewBandTicks(direction: TriggerDirection): { tickLower: number; tickUpper: number } {
    if (direction === 'lower') {
      // New band below the lowest
      const lowest = this.bands[0];
      return {
        tickLower: lowest.tickLower - this.bandTickWidth,
        tickUpper: lowest.tickLower,
      };
    }
    // New band above the highest
    const highest = this.bands[this.bands.length - 1];
    return {
      tickLower: highest.tickUpper,
      tickUpper: highest.tickUpper + this.bandTickWidth,
    };
  }

  removeBand(tokenId: BigNumber): void {
    this.bands = this.bands.filter((b) => !b.tokenId.eq(tokenId));
    // Re-index
    this.bands.forEach((b, i) => { b.index = i; });
  }

  addBand(band: Omit<Band, 'index'>, position: 'start' | 'end'): void {
    if (position === 'start') {
      this.bands.unshift({ ...band, index: 0 });
    } else {
      this.bands.push({ ...band, index: this.bands.length });
    }
    // Re-index
    this.bands.forEach((b, i) => { b.index = i; });
  }

  getOverallRange(): { tickLower: number; tickUpper: number } | undefined {
    if (this.bands.length === 0) return undefined;
    return {
      tickLower: this.bands[0].tickLower,
      tickUpper: this.bands[this.bands.length - 1].tickUpper,
    };
  }
}
