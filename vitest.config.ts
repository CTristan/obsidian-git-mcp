import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Git subprocess round-trips (fetch/rebase/push against the fixture remote) dominate
    // test time, so the default 5s timeout flakes on slower CI runners.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
