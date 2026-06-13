# Known Limitations

## Audit Recall Boundaries

`skill-switch audit` 是静态规则扫描器,目标是抓住高信号危险模式并避免阻断常见良性文档。它不是完整的恶意代码解释器。A5 的绕过语料固定在 `tests/audit-recall-corpus.test.ts`;当前结果如下。

### Currently Caught

| 样本 | 当前结果 | 说明 |
|---|---:|---|
| `plain-token-curl` | hit | 同行 `curl ... -d "$GITHUB_TOKEN"` 会命中 token/body 外传规则。 |
| `same-line-sensitive-file-exfil` | hit | 同行读取 `~/.aws/credentials` 并通过 `base64`/`curl` 外传会命中敏感路径外传规则。 |
| `credential-phishing-lure` | hit | 明确要求用户粘贴 API key/token 的话术会命中凭据钓鱼规则。 |

### Documented Misses

| 样本 | 当前结果 | 漏判原因 |
|---|---:|---|
| `base64-encoded-payload` | miss | 恶意命令整体被 base64 编码后再解码执行;当前规则不解码或模拟执行。 |
| `javascript-string-concat-endpoint` | miss | 外传 endpoint 被字符串拼接拆开;当前规则不做 JavaScript 常量折叠。 |
| `unicode-homoglyph-command-and-endpoint` | miss | `curl` 与 `webhook.site` 被 Unicode 同形/全宽字符伪装;当前规则不做同形归一化。 |
| `cross-line-token-and-endpoint-split` | miss | token、host、TLD、fetch 调用跨多行拆分;当前规则不做跨行数据流分析。 |

这些漏判是已知边界,不是安全保证。若后续实现解码、同形归一化、常量折叠或跨行数据流分析,需要同步更新这里和 A5 语料测试。
