import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 注意 gui 用 {ts,tsx}:此前只匹配 .tsx,导致 gui 的 .ts 测试(dashboard / run-with-timeout)
    // 被 CI 静默跳过。统一覆盖,避免「写了测试却没跑」。
    include: ['tests/**/*.test.ts', 'gui/tests/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup.ts'],
  },
});
