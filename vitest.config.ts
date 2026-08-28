import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Keep Playwright's browser specs out of the unit runner.
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
