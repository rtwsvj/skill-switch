import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'gui/tests/**/*.test.tsx'],
    setupFiles: ['tests/setup.ts'],
  },
});
