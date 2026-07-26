/**
 * Run `fn` over every item with at most `concurrency` calls in flight, returning the
 * results in input order. The work is sliced into fixed waves — each wave's Promise.all
 * settles before the next starts — rather than a sliding window, because the callers that
 * need this only need to stop an uncapped Promise.all from firing thousands of concurrent
 * lstat/readFile calls at once (a vault's file tree, or a gitignored .obsidian/, can hold
 * that many entries), which starves libuv's threadpool or hits EMFILE. Squeezing out the
 * last drop of overlap a sliding window would buy isn't worth its extra machinery here.
 *
 * Fail-fast: the first rejection in a wave rejects the whole call and no later wave runs,
 * matching a serial loop that throws on the first bad item. Results stay in input order
 * regardless of settle order, so a caller can index the returned array against its input.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new RangeError(`concurrency must be a positive integer, got ${concurrency}`);
  }
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const wave = await Promise.all(items.slice(i, i + concurrency).map((item) => fn(item)));
    results.push(...wave);
  }
  return results;
}

/**
 * A counting semaphore that bounds how many holders run `fn` at once. mapWithConcurrency's
 * fixed waves cap a single flat list, but they can't bound a *recursive* fan-out: manifestOf's
 * walk re-enters mapWithConcurrency at every directory level and sibling subtrees walk in
 * parallel, so a per-call cap of N lets a nested tree run N x (concurrently-walking directories)
 * operations at once. Threading one semaphore through the whole recursion instead keeps the
 * outstanding count at `permits` no matter the tree shape. Permits are handed FIFO so a waiter
 * can't be starved, and each is held only for the duration of one `fn` — a caller that recurses
 * must do so *after* run() returns, never while holding a permit, or the fan-out deadlocks.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits <= 0) {
      throw new RangeError(`permits must be a positive integer, got ${permits}`);
    }
    this.available = permits;
  }

  /** Runs one holder and releases its permit even when the holder rejects. */
  async run<R>(fn: () => Promise<R>): Promise<R> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** Takes an available permit or waits in FIFO order for a direct handoff. */
  private acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** Transfers a permit to the oldest waiter, or returns it to the available pool. */
  private release(): void {
    const next = this.waiters.shift();
    // Hand the permit straight to the oldest waiter rather than bumping the count and letting it
    // re-race — that transfer is what makes the ceiling hold exactly at `permits`.
    if (next === undefined) {
      this.available++;
    } else {
      next();
    }
  }
}
