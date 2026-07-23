import { describe, expect, it } from 'vitest';
import { mapWithConcurrency, Semaphore } from '../../src/concurrency.js';

function deferredDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('mapWithConcurrency', () => {
  it('returns results in input order regardless of settle order', async () => {
    // Earlier items resolve later, so a helper that returned settle order instead of
    // input order would reverse the result — ignoredFingerprint indexes stats[index]
    // against its sorted input, so this ordering guarantee is load-bearing there.
    const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const results = await mapWithConcurrency(items, 3, async (n) => {
      await deferredDelay((10 - n) * 2);
      return n * n;
    });
    expect(results).toEqual(items.map((n) => n * n));
  });

  it('never runs more than `concurrency` calls at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await mapWithConcurrency(items, 4, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await deferredDelay(5);
      inFlight--;
    });
    expect(maxInFlight).toBe(4);
  });

  it('caps in-flight at the item count when concurrency exceeds it', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency([1, 2, 3], 64, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await deferredDelay(5);
      inFlight--;
    });
    expect(maxInFlight).toBe(3);
  });

  it('rejects with the first error and starts no later wave (fail-fast)', async () => {
    // The serial loops this replaced threw on the first bad item; refuseUnvalidatedFetchedNotes
    // relies on that fail-fast to abort a note scan the moment one note is refused.
    const started: number[] = [];
    const boom = new Error('item 2 failed');
    const err = await mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (n) => {
      started.push(n);
      if (n === 2) throw boom;
      return n;
    }).catch((e: unknown) => e);

    expect(err).toBe(boom);
    // Wave 1 is [0,1], wave 2 is [2,3] (where 2 throws); the [4,5] wave must never start.
    expect(started).not.toContain(4);
    expect(started).not.toContain(5);
  });

  it('rejects a non-positive or non-integer concurrency with RangeError', async () => {
    for (const bad of [0, -1, 1.5, NaN]) {
      await expect(mapWithConcurrency([1, 2, 3], bad, async (n) => n)).rejects.toThrow(RangeError);
    }
  });

  it('returns an empty array for empty input without calling fn', async () => {
    let called = false;
    const results = await mapWithConcurrency([], 64, async () => {
      called = true;
      return 1;
    });
    expect(results).toEqual([]);
    expect(called).toBe(false);
  });
});

describe('Semaphore', () => {
  it('bounds concurrent holders globally across a recursive fan-out', async () => {
    // The manifestOf failure this guards: a cap re-applied at each recursion level lets sibling
    // subtrees multiply the real concurrency. One shared semaphore threaded through the recursion
    // must hold the global ceiling no matter the fan-out shape — each holder acquires, does its
    // work, releases, and only then fans out into more holders.
    const sem = new Semaphore(4);
    let inFlight = 0;
    let maxInFlight = 0;
    const visit = async (depth: number): Promise<void> => {
      await sem.run(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await deferredDelay(5);
        inFlight--;
      });
      if (depth > 0) {
        await Promise.all([visit(depth - 1), visit(depth - 1), visit(depth - 1)]);
      }
    };
    await visit(4);
    expect(maxInFlight).toBe(4);
  });

  it('rejects a non-positive or non-integer permit count with RangeError', () => {
    for (const bad of [0, -1, 1.5, NaN]) {
      expect(() => new Semaphore(bad)).toThrow(RangeError);
    }
  });

  it('releases the permit even when the holder throws', async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // A leaked permit would hang this second acquire forever; a bounded resolve proves release
    // ran on the throwing path.
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
  });
});
