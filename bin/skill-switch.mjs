#!/usr/bin/env node
// F11 bin shim:用 tsx loader 启动 TS CLI,不引入打包器。
// 关键:tsx 必须相对本脚本(仓库内)解析,而非相对调用方的 cwd——
// 否则全局 `skill-switch` 在仓库目录外运行会找不到 tsx(见 tests/bin.test.ts 回归)。
import { register } from 'tsx/esm/api';

register();
await import('../src/cli/index.ts');
