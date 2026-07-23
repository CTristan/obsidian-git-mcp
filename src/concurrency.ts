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
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const wave = await Promise.all(items.slice(i, i + concurrency).map((item) => fn(item)));
    results.push(...wave);
  }
  return results;
}
