import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 注意 gui 用 {ts,tsx}:此前只匹配 .tsx,导致 gui 的 .ts 测试(dashboard / run-with-timeout)
    // 被 CI 静默跳过。统一覆盖,避免「写了测试却没跑」。
    include: ['tests/**/*.test.ts', 'gui/tests/**/*.test.{ts,tsx}'],
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
      include: ['src/**/*.ts', 'gui/src/**/*.{ts,tsx}'],
      exclude: [
        'src/vendor/**',
        'tests/**',
        'gui/tests/**',
        '**/*.d.ts',
      ],
      // 覆盖率下限门禁:保守值(比实测 statements≈62.9%/branches≈60.4%/functions≈63.6%/lines≈63.4%
      // 各低 2-3%),防止覆盖率悄悄倒退,不求一步到位高覆盖。
      // 实测值记录(2026-06-28):statements 62.91%,branches 60.35%,functions 63.56%,lines 63.43%
      thresholds: {
        statements: 60,
        branches: 57,
        functions: 61,
        lines: 61,
      },
    },
  },
});
