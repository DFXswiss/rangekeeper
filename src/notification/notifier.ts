export interface Notifier {
  notify(message: string): Promise<void>;
}

export class CompositeNotifier implements Notifier {
  constructor(private readonly notifiers: Notifier[]) {}

  async notify(message: string): Promise<void> {
    await Promise.allSettled(this.notifiers.map((n) => n.notify(message)));
  }
}

export class ConsoleNotifier implements Notifier {
  async notify(message: string): Promise<void> {
    console.log(`[NOTIFICATION] ${message}`);
  }
}

export class DryRunNotifier implements Notifier {
  constructor(private readonly inner: Notifier) {}

  async notify(message: string): Promise<void> {
    await this.inner.notify(`[DRY RUN] ${message}`);
  }
}
