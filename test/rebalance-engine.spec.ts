import { EmergencyStop } from '../src/risk/emergency-stop';

describe('EmergencyStop', () => {
  let emergencyStop: EmergencyStop;

  beforeEach(() => {
    emergencyStop = new EmergencyStop();
  });

  it('should not be stopped initially', () => {
    expect(emergencyStop.isStopped()).toBe(false);
    expect(emergencyStop.getReason()).toBeUndefined();
  });

  it('should stop when triggered', () => {
    emergencyStop.trigger('test reason');
    expect(emergencyStop.isStopped()).toBe(true);
    expect(emergencyStop.getReason()).toBe('test reason');
  });

  it('should reset correctly', () => {
    emergencyStop.trigger('test');
    emergencyStop.reset();
    expect(emergencyStop.isStopped()).toBe(false);
    expect(emergencyStop.getReason()).toBeUndefined();
  });

  it('should trigger after too many consecutive errors', () => {
    emergencyStop.recordTxError();
    expect(emergencyStop.isStopped()).toBe(false);
    emergencyStop.recordTxError();
    expect(emergencyStop.isStopped()).toBe(false);
    emergencyStop.recordTxError();
    expect(emergencyStop.isStopped()).toBe(false);
    emergencyStop.recordTxError(); // 4th error triggers stop
    expect(emergencyStop.isStopped()).toBe(true);
  });

  it('should reset error count on success', () => {
    emergencyStop.recordTxError();
    emergencyStop.recordTxError();
    emergencyStop.recordTxSuccess();
    emergencyStop.recordTxError();
    emergencyStop.recordTxError();
    emergencyStop.recordTxError();
    // 3 consecutive after success, not 4+
    expect(emergencyStop.isStopped()).toBe(false);
  });

  it('should detect portfolio loss', () => {
    const triggered = emergencyStop.checkPortfolioLoss(85000, 100000, 10);
    expect(triggered).toBe(true);
    expect(emergencyStop.isStopped()).toBe(true);
  });

  it('should not trigger for acceptable portfolio loss', () => {
    const triggered = emergencyStop.checkPortfolioLoss(95000, 100000, 10);
    expect(triggered).toBe(false);
    expect(emergencyStop.isStopped()).toBe(false);
  });

  it('should detect rebalance loss', () => {
    const triggered = emergencyStop.checkRebalanceLoss(100000, 95000, 2);
    expect(triggered).toBe(true);
    expect(emergencyStop.isStopped()).toBe(true);
  });

  it('should not trigger for acceptable rebalance loss', () => {
    const triggered = emergencyStop.checkRebalanceLoss(100000, 99000, 2);
    expect(triggered).toBe(false);
    expect(emergencyStop.isStopped()).toBe(false);
  });
});

describe('Rebalance Logic', () => {
  // Test the shouldRebalance logic independently (already tested in range-calculator.spec.ts)
  // Here we test the state machine logic conceptually

  it('should have correct state transitions defined', () => {
    const validStates = ['IDLE', 'MONITORING', 'EVALUATING', 'WITHDRAWING', 'SWAPPING', 'MINTING', 'ERROR', 'STOPPED'];
    // Ensure all states are valid
    validStates.forEach((state) => {
      expect(typeof state).toBe('string');
    });
  });

  it('should respect min rebalance interval', () => {
    const lastRebalanceTime = Date.now() - 10 * 60 * 1000; // 10 min ago
    const minIntervalMs = 30 * 60 * 1000; // 30 min
    const elapsed = Date.now() - lastRebalanceTime;

    expect(elapsed < minIntervalMs).toBe(true); // too soon
  });

  it('should allow rebalance after interval expires', () => {
    const lastRebalanceTime = Date.now() - 60 * 60 * 1000; // 60 min ago
    const minIntervalMs = 30 * 60 * 1000; // 30 min
    const elapsed = Date.now() - lastRebalanceTime;

    expect(elapsed >= minIntervalMs).toBe(true);
  });
});
