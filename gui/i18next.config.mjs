// i18next-cli 配置。
// 用于 CI 漏译检测:pnpm --dir gui i18n:check
//
// 只检查、不写文件:
//   ci 脚本用 `i18next-cli status`(只读,不修改任何 locale 文件)。
//   extract 命令(会写文件)不进 CI。
//
// 设计决策:
//   - disablePlurals: true — 项目 locale 文件用非 plural 形式(key 而非 key_one/key_other),
//     i18next-cli 静态分析默认会把 t('key', {count}) 解析成 key_one/key_other 导致误报。
//   - preservePatterns: ['errors.*'] — errors.${code} 是运行时动态 key,
//     静态分析无法提取,用 preservePatterns 告知工具保留 errors.* 节。
//
// 当前状态(2026-06-28):
//   en/zh-CN/ja/es 全部 225 个 key 覆盖率 100%。
//   若新增 t() 调用但未在所有 locale 文件中补充 key,CI 会失败。
export default {
  locales: ['en', 'zh-CN', 'ja', 'es'],
  primaryLocale: 'en',
  extract: {
    // 扫描 gui/src 下所有 TS/TSX 文件中的 t() 调用
    input: ['src/**/*.{ts,tsx}'],
    // locale 文件路径模板(单文件/单 namespace 格式)
    output: 'src/locales/{{language}}.json',
    // 禁用 plural 后缀解析:项目使用 key 而非 key_one/key_other 格式
    disablePlurals: true,
    // 保留 errors.* 节:errors.${code} 是运行时动态 key,静态分析无法提取
    preservePatterns: ['errors.*'],
  },
};
