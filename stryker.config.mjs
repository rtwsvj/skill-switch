// Stryker 变异测试配置。
// 范围收敛到两个核心文件:audit/engine.ts + audit/score.ts。
// 全量 mutate 太慢(数千条测试),故只对最关键的业务逻辑做变异测试。
//
// 运行方式:
//   pnpm mutate                   # 一次性全量跑
//   pnpm mutate --incremental     # 仅对变化的代码增量跑(速度更快)
//
// 注意:变异测试不进 CI 必跑流程(太慢),只作可手动/定期跑的质量工具。
// 建议在发布前或修改 engine.ts / score.ts 后手动执行一次。
/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
export default {
  // 测试运行器
  testRunner: 'vitest',

  // 变异范围:只针对 audit 核心,避免全量跑几千条测试
  mutate: [
    'src/core/audit/engine.ts',
    'src/core/audit/score.ts',
  ],

  // vitest 运行器选项
  vitest: {
    // 使用项目根目录的 vitest.config.ts
    configFile: 'vitest.config.ts',
  },

  // 变异算子:使用默认算子集合即可
  // (ArithmeticOperator / BooleanLiteral / ConditionalExpression /
  //  EqualityOperator / LogicalOperator / StringLiteral 等)

  // 并发 workers:不设太高,避免 CI 机器挤爆内存
  concurrency: 2,

  // 超时倍数:单测在 CI 环境可能慢 2-3x,给足余量
  timeoutMS: 60_000,
  timeoutFactor: 2,

  // 报告格式
  reporters: ['progress', 'html', 'json'],

  // HTML/JSON 报告输出目录(gitignore 中的 .stryker-tmp 不入库)
  htmlReporter: {
    fileName: 'reports/stryker/mutation.html',
  },
  jsonReporter: {
    fileName: 'reports/stryker/mutation.json',
  },

  // 增量模式文件(用于 --incremental 加速)
  incrementalFile: 'reports/stryker/stryker-incremental.json',

  // 日志级别
  logLevel: 'info',

  // 临时目录(避免占用项目目录)
  tempDirName: '.stryker-tmp',

  // 阈值(仅作参考,不阻断;可按需调整)
  // thresholds: { high: 80, low: 60, break: 50 },
};
