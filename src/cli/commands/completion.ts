// completion 子命令:输出 shell 自动补全脚本(bash / zsh / fish)。
// 纯本地生成,零依赖,不读网络,不写磁盘(--install 写 ~/.bashrc 等由用户自己决定)。
//
// 用法:
//   eval "$(skill-switch completion bash)"   # 当前 shell 立即生效
//   skill-switch completion zsh              # 输出 zsh 脚本,手动加到 .zshrc
//   skill-switch completion fish             # 输出 fish 补全文件内容
import type { Command } from 'commander';

// 顶层命令名列表(与 program.ts 注册顺序保持一致,completion 本身也加进来)。
// 注意:这里硬编码是故意的——completion 脚本需要在没有 node 的环境里(纯 shell)工作。
// 如果以后新增命令,请同步更新此列表。
const TOP_LEVEL_COMMANDS = [
  'status',
  'scan',
  'init',
  'audit',
  'ci',
  'explain',
  'add',
  'install',
  'toggle',
  'sync',
  'remove',
  'restore',
  'lint',
  'doctor',
  'diff',
  'drift',
  'stats',
  'packs',
  'mcp',
  'lock',
  'export',
  'import',
  'uninstall',
  'watch',
  'completion',
] as const;

function bashScript(cmds: readonly string[]): string {
  const cmdList = cmds.join(' ');
  return `# skill-switch bash 补全脚本
# 用法:在 ~/.bashrc 或 ~/.bash_profile 里加一行:
#   eval "$(skill-switch completion bash)"
_skill_switch_completions() {
  local cur prev words cword
  _init_completion 2>/dev/null || {
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
  }
  local cmds="${cmdList}"
  local flags="--json --home --agent --help --version"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( \$(compgen -W "\${cmds} \${flags}" -- "\${cur}") )
    return 0
  fi

  # 子命令后继续补全公共 flag
  COMPREPLY=( \$(compgen -W "\${flags}" -- "\${cur}") )
}
complete -F _skill_switch_completions skill-switch
`;
}

function zshScript(cmds: readonly string[]): string {
  const cmdEntries = cmds.map((c) => `    '${c}'`).join('\n');
  return `#compdef skill-switch
# skill-switch zsh 补全脚本
# 用法:
#   1) 把输出保存到 $fpath 里的某个目录,文件名 _skill-switch:
#      skill-switch completion zsh > ~/.zsh/completions/_skill-switch
#   2) 确保 ~/.zsh/completions 在 $fpath 里,然后重启 shell 或:
#      autoload -Uz compinit && compinit
#
# 或者直接 eval(不推荐,每次启动都跑):
#   eval "$(skill-switch completion zsh)"
_skill_switch() {
  local -a commands
  commands=(
${cmdEntries}
  )
  local -a global_flags
  global_flags=(
    '--json[以 JSON 格式输出]'
    '--home[覆盖 home 根目录]:目录:_files -/'
    '--agent[指定目标 agent 工具]:工具:(claude-code codex gemini-cli cursor copilot)'
    '--help[显示帮助]'
    '--version[输出版本号]'
  )
  _arguments -C \\
    "1: :->command" \\
    "*:: :->args" \\
    \${global_flags}
  case \$state in
    command)
      _describe '命令' commands
      ;;
    args)
      _arguments \${global_flags}
      ;;
  esac
}
_skill_switch
`;
}

function fishScript(cmds: readonly string[]): string {
  const completionLines = cmds
    .map((c) => `complete -c skill-switch -f -n '__fish_use_subcommand' -a '${c}'`)
    .join('\n');
  return `# skill-switch fish 补全脚本
# 用法:
#   skill-switch completion fish > ~/.config/fish/completions/skill-switch.fish
#
# fish 会自动加载 ~/.config/fish/completions/ 里的文件。

# 禁用文件补全(我们自己管)
complete -c skill-switch -f

# 顶层命令
${completionLines}

# 公共 flag
complete -c skill-switch -l json    -d '以 JSON 格式输出'
complete -c skill-switch -l home    -d '覆盖 home 根目录' -r
complete -c skill-switch -l agent   -d '指定目标 agent 工具' -r -a 'claude-code codex gemini-cli cursor copilot'
complete -c skill-switch -l help    -d '显示帮助'
complete -c skill-switch -l version -d '输出版本号'
`;
}

export function registerCompletionCommand(program: Command): void {
  program
    .command('completion [shell]')
    .description(
      'Shell 自动补全:输出 bash / zsh / fish 补全脚本。用法: eval "$(skill-switch completion bash)"',
    )
    .addHelpText(
      'after',
      `
示例:
    eval "$(skill-switch completion bash)"   # bash:当前 shell 立即生效
    skill-switch completion zsh > ~/.zsh/completions/_skill-switch  # zsh
    skill-switch completion fish > ~/.config/fish/completions/skill-switch.fish
`,
    )
    .action((shell: string | undefined) => {
      // 未指定 shell 时检测当前 shell。
      const target = (shell ?? process.env['SHELL'] ?? 'bash').replace(/^.*\//, '').toLowerCase();

      const cmds = TOP_LEVEL_COMMANDS;
      let script: string;

      if (target === 'zsh') {
        script = zshScript(cmds);
      } else if (target === 'fish') {
        script = fishScript(cmds);
      } else {
        // 默认 bash(含 sh 回退)。
        script = bashScript(cmds);
      }

      process.stdout.write(script);
    });
}
