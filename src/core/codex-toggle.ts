// S4.2 Codex 原生开关:对 ~/.codex/config.toml 的 [[skills.config]] 做行级手术式编辑。
// 依据:Codex 官方支持 `[[skills.config]] path=… enabled=false`(调研报告⑥,需重启生效)。
// 刻意不引入 TOML 解析依赖:parse→re-serialize 会摧毁用户的注释与排版;
// 行级编辑只动我们管辖的 skills.config 小节,其余内容字节不变。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function getCodexConfigPath(home: string): string {
  return join(home, '.codex', 'config.toml');
}

const SECTION_HEADER = /^\s*\[\[skills\.config\]\]\s*(?:#.*)?$/;
const ANY_HEADER = /^\s*\[/;
const PATH_LINE = /^\s*path\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/;
const ENABLED_LINE = /^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/;

interface Section {
  /** [[skills.config]] 头所在行号 */
  start: number;
  /** 小节内(不含头)最后一行的行号 */
  end: number;
  path?: string;
  enabledLine?: number;
  enabled?: boolean;
  pathLine?: number;
}

function parseSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  let current: Section | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (SECTION_HEADER.test(line)) {
      current = { start: i, end: i };
      sections.push(current);
      continue;
    }
    if (ANY_HEADER.test(line)) {
      current = undefined;
      continue;
    }
    if (!current) continue;
    const pathMatch = PATH_LINE.exec(line);
    if (pathMatch) {
      current.path = pathMatch[1] ?? pathMatch[2];
      current.pathLine = i;
    }
    const enabledMatch = ENABLED_LINE.exec(line);
    if (enabledMatch) {
      current.enabled = enabledMatch[1] === 'true';
      current.enabledLine = i;
    }
    if (line.trim() !== '') current.end = i;
  }
  return sections;
}

async function readConfigLines(configPath: string): Promise<string[] | undefined> {
  try {
    return (await readFile(configPath, 'utf8')).split('\n');
  } catch {
    return undefined;
  }
}

/** 该 skill 在 config 中的开关状态;无对应小节返回 undefined(Codex 默认启用)。 */
export async function readCodexSkillEnabled(
  configPath: string,
  skillPath: string,
): Promise<boolean | undefined> {
  const lines = await readConfigLines(configPath);
  if (!lines) return undefined;
  const section = parseSections(lines).find((s) => s.path === skillPath);
  if (!section) return undefined;
  return section.enabled ?? true; // 有小节但没写 enabled,TOML 语义上等同启用
}

export async function setCodexSkillEnabled(
  configPath: string,
  skillPath: string,
  enabled: boolean,
): Promise<{ changed: boolean }> {
  const original = await readConfigLines(configPath);
  const lines = original ? [...original] : [];
  const section = parseSections(lines).find((s) => s.path === skillPath);

  if (section) {
    const want = `enabled = ${enabled}`;
    if (section.enabledLine !== undefined) {
      if (section.enabled === enabled) return { changed: false };
      lines[section.enabledLine] = want;
    } else {
      lines.splice((section.pathLine ?? section.start) + 1, 0, want);
    }
  } else {
    // 追加新小节:保持与已有内容之间一个空行,文件以换行结尾
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    if (lines.length > 0) lines.push('');
    lines.push('[[skills.config]]', `path = "${skillPath}"`, `enabled = ${enabled}`, '');
  }

  const next = lines.join('\n');
  if (original && next === original.join('\n')) return { changed: false };
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, next.endsWith('\n') ? next : `${next}\n`);
  return { changed: true };
}
