# skill-switch 发行版分发指南

本文说明三种安装方式:Homebrew(macOS)、Scoop(Windows)、npm(跨平台 CLI)。

---

## 1. npm(最简单,跨平台)

无需安装,直接用 `npx`:

```bash
npx @rtwsvj/skill-switch --help
npx @rtwsvj/skill-switch audit --configs
```

或全局安装:

```bash
npm install -g @rtwsvj/skill-switch
skill-switch --help
```

---

## 2. Homebrew(macOS)

> Homebrew tap 托管在 [rtwsvj/homebrew-tap](https://github.com/rtwsvj/homebrew-tap)。
> Formula 源文件位于本仓库 `packaging/skill-switch.rb`,发布时同步复制到 tap 仓库。

```bash
brew tap rtwsvj/tap
brew install skill-switch
```

升级:

```bash
brew upgrade skill-switch
```

卸载:

```bash
brew uninstall skill-switch
brew untap rtwsvj/tap
```

### Shell 自动补全(Homebrew)

```bash
# bash
eval "$(skill-switch completion bash)"
# 持久化:
echo 'eval "$(skill-switch completion bash)"' >> ~/.bashrc

# zsh(写入 Homebrew 的 site-functions,下次 compinit 自动加载)
skill-switch completion zsh > $(brew --prefix)/share/zsh/site-functions/_skill-switch

# fish
skill-switch completion fish > ~/.config/fish/completions/skill-switch.fish
```

### 维护:更新 Formula

1. 发布新 GitHub Release,获取 DMG 的 SHA-256:
   ```bash
   curl -sL https://github.com/rtwsvj/skill-switch/releases/download/vX.Y.Z/skill-switch_X.Y.Z_aarch64.dmg | shasum -a 256
   ```
2. 编辑 `packaging/skill-switch.rb`,更新 `version`、`url`、`sha256`。
3. 把更新后的 Formula 推送到 `rtwsvj/homebrew-tap` 仓库的 `Formula/` 目录。

---

## 3. Scoop(Windows)

> Scoop bucket 托管在 [rtwsvj/scoop-bucket](https://github.com/rtwsvj/scoop-bucket)。
> Manifest 源文件位于本仓库 `packaging/skill-switch.json`,发布时同步复制到 bucket 仓库。

```powershell
scoop bucket add rtwsvj-bucket https://github.com/rtwsvj/scoop-bucket
scoop install skill-switch
```

升级:

```powershell
scoop update skill-switch
```

卸载:

```powershell
scoop uninstall skill-switch
```

### 维护:更新 Manifest

1. 发布新 GitHub Release,获取 MSI 的 SHA-256(PowerShell):
   ```powershell
   (Get-FileHash skill-switch_X.Y.Z_x64_en-US.msi -Algorithm SHA256).Hash
   ```
2. 编辑 `packaging/skill-switch.json`,更新 `version`、`url`、`hash`。
3. 推送到 `rtwsvj/scoop-bucket` 仓库。

---

## 4. macOS DMG(手动)

```bash
# 1. 下载 DMG
curl -L -O https://github.com/rtwsvj/skill-switch/releases/latest/download/skill-switch_0.8.0_aarch64.dmg

# 2. 双击挂载,把 skill-switch.app 拖进「应用程序」
# 3. 链 CLI 到 PATH
ln -sf /Applications/skill-switch.app/Contents/MacOS/skill-switch-cli /usr/local/bin/skill-switch
skill-switch --help
```

---

## 5. Linux AppImage / deb

```bash
# AppImage(通用)
chmod +x skill-switch_*.AppImage
./skill-switch_*.AppImage --help

# deb(Debian / Ubuntu)
sudo dpkg -i skill-switch_*.deb
skill-switch --help
```

---

## 6. bun compile（实验性，面向开发者）

> ⚠ **实验阶段**：bun 路径尚未取代 Node SEA，两条路径并列存在。
> 待验证充分（Tauri sidecar 集成、CI 全平台冒烟）后再正式切换。

### 原理

[Bun](https://bun.sh/) 可将 TypeScript 源码直接编译成单文件原生可执行文件，
无需 Node.js 运行时——与 Node SEA（`bundle-cli.mjs`）目标相同，但实现路径不同：

| 维度           | Node SEA（当前正式路径）          | bun compile（实验路径）             |
| -------------- | --------------------------------- | ----------------------------------- |
| 打包工具       | esbuild → Node SEA + postject     | bun build --compile                 |
| 冷启动速度     | ~8–12 s（含 Node 解压开销）       | <100 ms（原生可执行，无 VM 启动）   |
| 跨平台编译     | 须在目标平台运行                  | 同上（须在目标平台运行）            |
| 产物命名       | `skill-switch-cli-<triple>`       | 相同                                |
| 输出目录       | `gui/src-tauri/bin/`              | 相同                                |
| Tauri 集成状态 | ✅ 已验证                          | 🚧 待验证（产物格式待 Tauri 确认）  |

### 构建步骤（本地开发）

```bash
# 确保 devDependency bun 已安装
pnpm install

# 验证 bun 可用
pnpm exec bun --version

# 构建（产物写到 gui/src-tauri/bin/skill-switch-cli-<triple>）
pnpm bundle:cli:bun

# 快速冒烟验证
./gui/src-tauri/bin/skill-switch-cli-$(rustc --print host-tuple) --version
```

### 已知限制与坑

1. **`node:sea` 不兼容**：`src/cli/index.ts` 导入了 `node:sea`（Node 内置），bun 不提供此模块。
   `bundle-cli-bun.mjs` 用一个临时 wrapper 入口绕过，不改动 `src/` 下任何文件。

2. **Tauri sidecar 集成待验证**：Tauri 对 `externalBin` 产物的签名/公证要求与 Node SEA 相同，
   但 bun 产物是纯原生二进制，理论上更容易通过公证；尚未在 CI 全流程中验证。

3. **re2 原生模块**：`re2` 是 Node 原生扩展（`.node`），bun 1.x 对 Node 原生扩展的支持有限，
   bun compile 可能无法正确打包 `re2`——如遇问题，需用 `--external re2` 并随二进制附带 `.node` 文件。

4. **CI 兼容性**：`pnpm add -D bun` 安装的是 npm 上的 bun 包（含平台特定二进制），
   CI runner 需要允许 `bun` 的 postinstall 脚本（已在 `pnpm-workspace.yaml` 的 `allowBuilds` 中配置）。

---

## 发布流程(维护者)

1. `pnpm release` 在本机做本地 smoke test(需 macOS + Developer ID)。
2. 推送 git tag(`git tag v0.X.Y && git push origin v0.X.Y`)。
3. `.github/workflows/release.yml` 自动在三平台构建并上传到 GitHub Release。
4. 更新 `packaging/skill-switch.rb`(Homebrew)和 `packaging/skill-switch.json`(Scoop),同步到对应 tap/bucket 仓库。
5. `npm publish --access public`(CLI npm 包)。

> 详细签名公证步骤见 [docs/release/signing.md](./release/signing.md)。
