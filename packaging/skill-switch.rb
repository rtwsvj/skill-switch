# Homebrew Formula for skill-switch
# 托管在 https://github.com/rtwsvj/homebrew-tap
#
# 安装方法:
#   brew tap rtwsvj/tap
#   brew install skill-switch
#
# 更新 Formula:
# 1) 在 GitHub Release 页面获取新版本的 DMG sha256:
#      curl -sL <dmg_url> | shasum -a 256
# 2) 更新下方 version / url / sha256 字段。
# 3) 提交到 homebrew-tap 仓库。

class SkillSwitch < Formula
  desc "AI agent skills 与 MCP/agent 配置的安全审计与治理工具"
  homepage "https://github.com/rtwsvj/skill-switch"
  version "0.8.0"

  # macOS Apple Silicon
  on_arm do
    url "https://github.com/rtwsvj/skill-switch/releases/download/v#{version}/skill-switch_#{version}_aarch64.dmg"
    sha256 "PLACEHOLDER_AARCH64_SHA256"
  end

  # macOS Intel
  on_intel do
    url "https://github.com/rtwsvj/skill-switch/releases/download/v#{version}/skill-switch_#{version}_x64.dmg"
    sha256 "PLACEHOLDER_X64_SHA256"
  end

  # DMG 包含签名 .app,无需 sudo,直接把 CLI 链接到 prefix。
  # 若发布独立 CLI 二进制(非 DMG),可改为直接下载二进制并 bin.install。
  def install
    # 挂载 DMG,把 .app 复制到 prefix,再链 CLI。
    # Homebrew cask 更适合 GUI App;这里只链出 CLI 二进制。
    # 实际发布时建议额外提供独立 CLI tar.gz(见 docs/distribution.md)。
    #
    # 示例(独立 CLI tar.gz 路径,发布时取消注释):
    #   bin.install "skill-switch-cli" => "skill-switch"
    #
    # 暂用 npm fallback:
    system "npm", "install", "-g", "@rtwsvj/skill-switch",
           "--prefix", prefix
    bin.install_symlink prefix/"bin/skill-switch"
  end

  def caveats
    <<~EOS
      skill-switch CLI 已安装。快速上手:
        skill-switch --help
        skill-switch audit --configs

      Shell 自动补全(可选):
        eval "$(skill-switch completion bash)"   # bash
        skill-switch completion zsh > $(brew --prefix)/share/zsh/site-functions/_skill-switch  # zsh
    EOS
  end

  test do
    # smoke test:版本号格式正确
    assert_match(/\d+\.\d+\.\d+/, shell_output("#{bin}/skill-switch --version"))
  end
end
