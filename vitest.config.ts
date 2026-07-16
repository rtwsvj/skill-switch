import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // 全局超时 30s:大量 CLI 集成测试每例 spawn 一个 tsx 冷启动子进程,满负载并发跑全量时
    // 冷启动可达数秒,默认 5s 会偶发误判超时(每次挂的是随机的几个,隔离重跑都过 = flaky)。
    // 30s 给冷启动足够余量,又仍能抓住真正挂死的测试。个别文件可再自行 vi.setConfig 覆盖。
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // 覆盖率配置:需要 @vitest/coverage-v8 devDependency。
    // 运行: pnpm test:coverage
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // Security rules live outside src/ and must participate in the gate.
      include: ['src/**/*.ts', 'rules/**/*.ts'],
      exclude: [
        'src/vendor/**',
        'tests/**',
        '**/*.d.ts',
      ],
      // Global floor prevents broad regression; focused regression suites cover
      // the security/state/network seams that aggregate percentages can hide.
      // 2026-07-11 measured baseline (rules included): statements 69.60,
      // branches 64.51, functions 73.34, lines 70.59. Floors retain 2-3 points
      // of platform variance while making the previous 57-61% gate meaningful.
      thresholds: {
        statements: 67,
        branches: 62,
        functions: 70,
        lines: 68,
      },
    },
  },
});
