export class SessionBuffer {
  private events: unknown[] = [];
  private maxSize: number;

  constructor(maxSize = 50_000) {
    this.maxSize = maxSize;
  }

  push(event: unknown): void {
    this.events.push(event);
    if (this.events.length > this.maxSize) {
      this.events.shift();
    }
  }

  all(): unknown[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
  }
}
