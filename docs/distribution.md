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

## 发布流程(维护者)

1. `pnpm release` 在本机做本地 smoke test(需 macOS + Developer ID)。
2. 推送 git tag(`git tag v0.X.Y && git push origin v0.X.Y`)。
3. `.github/workflows/release.yml` 自动在三平台构建并上传到 GitHub Release。
4. 更新 `packaging/skill-switch.rb`(Homebrew)和 `packaging/skill-switch.json`(Scoop),同步到对应 tap/bucket 仓库。
5. `npm publish --access public`(CLI npm 包)。

> 详细签名公证步骤见 [docs/release/signing.md](./release/signing.md)。
