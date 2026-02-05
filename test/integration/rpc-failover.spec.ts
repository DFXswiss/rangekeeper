jest.mock('../../src/util/logger', () => ({
  getLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

import { FailoverProvider } from '../../src/chain/evm-provider';

describe('RPC Failover Integration', () => {
  it('5 consecutive errors switch to backup URL', () => {
    const provider = new FailoverProvider(['http://primary:8545', 'http://backup:8545'], 5);

    expect(provider.getCurrentUrl()).toBe('http://primary:8545');

    // Record 4 errors — not enough to switch
    for (let i = 0; i < 4; i++) {
      provider.recordError();
    }
    expect(provider.getCurrentUrl()).toBe('http://primary:8545');

    // 5th error triggers failover
    const switched = provider.recordError();
    expect(switched).toBe(true);
    expect(provider.getCurrentUrl()).toBe('http://backup:8545');
  });

  it('success resets error counter', () => {
    const provider = new FailoverProvider(['http://primary:8545', 'http://backup:8545'], 5);

    // 4 errors
    for (let i = 0; i < 4; i++) {
      provider.recordError();
    }

    // Success resets
    provider.recordSuccess();

    // 4 more errors — still on primary (reset happened)
    for (let i = 0; i < 4; i++) {
      provider.recordError();
    }
    expect(provider.getCurrentUrl()).toBe('http://primary:8545');
  });

  it('single RPC URL results in no failover possible', () => {
    const provider = new FailoverProvider(['http://only:8545'], 3);

    for (let i = 0; i < 10; i++) {
      provider.recordError();
    }

    // Still on the same URL
    expect(provider.getCurrentUrl()).toBe('http://only:8545');
  });

  it('failover callback invoked with from/to URLs and new provider', () => {
    const provider = new FailoverProvider(['http://primary:8545', 'http://backup:8545'], 3);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let callbackArgs: { from: string; to: string; newProvider: any } | undefined;
    provider.setFailoverCallback((from, to, newProvider) => {
      callbackArgs = { from, to, newProvider };
    });

    // Trigger failover
    for (let i = 0; i < 3; i++) {
      provider.recordError();
    }

    expect(callbackArgs).toBeDefined();
    expect(callbackArgs!.from).toBe('http://primary:8545');
    expect(callbackArgs!.to).toBe('http://backup:8545');
    expect(callbackArgs!.newProvider).toBeDefined();
  });
});
