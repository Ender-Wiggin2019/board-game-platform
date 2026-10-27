import { contractError } from '@board-game/contracts';

export interface SessionQueueMetrics {
  readonly draining: boolean;
  readonly queuedSessions: number;
  readonly queuedCommands: number;
  readonly runningCommands: number;
  readonly maxQueuedSessions: number;
  readonly maxQueuedPerSession: number;
}

/** Bounds local work only; the storage transaction fences other Host instances. */
export class SessionQueue {
  private readonly queues = new Map<
    string,
    { tail: Promise<void>; size: number; running: number }
  >();
  private draining = false;

  constructor(
    private readonly maxPerSession = 32,
    private readonly maxSessions = 1024,
  ) {
    if (
      !Number.isSafeInteger(maxPerSession) ||
      maxPerSession < 1 ||
      !Number.isSafeInteger(maxSessions) ||
      maxSessions < 1
    ) {
      throw new Error('Queue limits must be positive integers');
    }
  }

  async run<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    if (this.draining) throw contractError('NOT_READY', 'host.draining', true);
    let queue = this.queues.get(sessionId);
    if (!queue) {
      if (this.queues.size >= this.maxSessions) {
        throw contractError('RATE_LIMITED', 'host.queue.full', true);
      }
      queue = { tail: Promise.resolve(), size: 0, running: 0 };
      this.queues.set(sessionId, queue);
    }
    if (queue.size >= this.maxPerSession) {
      throw contractError('RATE_LIMITED', 'host.queue.full', true);
    }
    queue.size += 1;
    const previous = queue.tail;
    let release!: () => void;
    queue.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      queue.running += 1;
      return await work();
    } finally {
      queue.running = Math.max(0, queue.running - 1);
      queue.size -= 1;
      release();
      if (queue.size === 0) this.queues.delete(sessionId);
    }
  }

  async drain(): Promise<void> {
    this.draining = true;
    await Promise.all([...this.queues.values()].map((queue) => queue.tail));
  }

  metrics(): SessionQueueMetrics {
    let queuedCommands = 0;
    let runningCommands = 0;
    for (const queue of this.queues.values()) {
      queuedCommands += queue.size;
      runningCommands += queue.running;
    }
    return {
      draining: this.draining,
      queuedSessions: this.queues.size,
      queuedCommands,
      runningCommands,
      maxQueuedSessions: this.maxSessions,
      maxQueuedPerSession: this.maxPerSession,
    };
  }
}
