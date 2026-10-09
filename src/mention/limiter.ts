/** Limits the number of concurrent tasks and the queue length. */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(
    private readonly maxActive: number,
    private readonly maxQueue: number
  ) {}

  /** Whether any task is running or queued */
  get busy(): boolean {
    return this.active > 0 || this.queue.length > 0;
  }

  /** Runs or queues the task and returns true if there is room, false if full */
  tryRun(task: () => Promise<void>): boolean {
    if (this.active >= this.maxActive && this.queue.length >= this.maxQueue) return false;
    const start = () => {
      this.active += 1;
      void task()
        .catch(() => undefined)
        .finally(() => {
          this.active -= 1;
          this.queue.shift()?.();
        });
    };
    if (this.active < this.maxActive) start();
    else this.queue.push(start);
    return true;
  }
}
