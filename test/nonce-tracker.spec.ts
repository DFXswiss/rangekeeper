import { NonceTracker } from '../src/chain/nonce-tracker';

jest.mock('../src/util/logger', () => ({
  getLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

describe('NonceTracker', () => {
  const walletAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  let mockProvider: { getTransactionCount: jest.Mock };
  let tracker: NonceTracker;

  beforeEach(() => {
    mockProvider = {
      getTransactionCount: jest.fn().mockResolvedValue(10),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tracker = new NonceTracker(walletAddress, () => mockProvider as any);
  });

  it('should initialize nonce from provider when no persisted nonce', async () => {
    await tracker.initialize();
    expect(mockProvider.getTransactionCount).toHaveBeenCalledWith(walletAddress, 'latest');
    expect(tracker.getNextNonce()).toBe(10);
  });

  it('should take max of persisted nonce and on-chain nonce', async () => {
    await tracker.initialize(15);
    expect(tracker.getNextNonce()).toBe(15);
  });

  it('should use on-chain nonce when it is higher than persisted', async () => {
    mockProvider.getTransactionCount.mockResolvedValue(20);
    await tracker.initialize(15);
    expect(tracker.getNextNonce()).toBe(20);
  });

  it('should increment nonce on confirmNonce', async () => {
    await tracker.initialize();
    expect(tracker.getNextNonce()).toBe(10);
    tracker.confirmNonce();
    expect(tracker.getNextNonce()).toBe(11);
    tracker.confirmNonce();
    expect(tracker.getNextNonce()).toBe(12);
  });

  it('should throw on getNextNonce before initialize', () => {
    expect(() => tracker.getNextNonce()).toThrow('NonceTracker not initialized');
  });

  it('should throw on confirmNonce before initialize', () => {
    expect(() => tracker.confirmNonce()).toThrow('NonceTracker not initialized');
  });

  it('should return undefined from getCurrentNonce before initialize', () => {
    expect(tracker.getCurrentNonce()).toBeUndefined();
  });

  it('should sync nonce on failover taking max of local and remote', async () => {
    await tracker.initialize(); // nonce = 10
    tracker.confirmNonce(); // nonce = 11
    tracker.confirmNonce(); // nonce = 12

    // On-chain only has nonce 10 (some TXs not yet confirmed)
    mockProvider.getTransactionCount.mockResolvedValue(10);
    await tracker.syncOnFailover();
    expect(tracker.getNextNonce()).toBe(12); // keeps local (higher)

    // On-chain has nonce 15 (other TXs happened)
    mockProvider.getTransactionCount.mockResolvedValue(15);
    await tracker.syncOnFailover();
    expect(tracker.getNextNonce()).toBe(15); // takes on-chain (higher)
  });
});
