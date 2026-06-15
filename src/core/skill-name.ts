import { basename, posix, win32 } from 'node:path';

// Windows 保留设备名(不分大小写;带扩展名同样保留,如 CON.md / NUL.txt)。
const WINDOWS_RESERVED = new Set<string>([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

// 规范命名策略(用于新安装/导入的 skill 名):首字符字母数字,其余字母数字 . _ -,长度 1–80。
const CANONICAL_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/** 是否含任何控制字符(NUL 0x00–0x1F 及 DEL 0x7F)。 */
function hasControlChar(name: string): boolean {
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * 安全护栏(路径/文件系统安全):拒绝路径分隔符、绝对路径、`.`/`..`/前导点、尾随点、
 * 所有控制字符、Windows 保留设备名。所有命令(含对既有 skill 的操作)都应通过此关。
 */
export function isSafeSkillName(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  if (name.length === 0) return false;
  if (hasControlChar(name)) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (posix.isAbsolute(name) || win32.isAbsolute(name)) return false;
  if (name === '.' || name === '..' || name.startsWith('.')) return false;
  if (name.endsWith('.')) return false; // 尾随点:Windows 会静默去掉,造成歧义
  const stem = (name.split('.')[0] ?? name).toUpperCase();
  if (WINDOWS_RESERVED.has(stem)) return false;
  return basename(name) === name;
}

export function assertSafeSkillName(name: unknown, context = 'skill name'): asserts name is string {
  if (!isSafeSkillName(name)) {
    throw new Error(`Unsafe ${context}: ${JSON.stringify(name)}`);
  }
}

/**
 * 规范命名(更严):在安全护栏基础上,再要求匹配 CANONICAL_SKILL_NAME(无空格/Unicode 等)。
 * 用于新安装/导入入口;对既有 legacy 名应给迁移告警而非硬拒(见 doctor migration 计划)。
 */
export function isCanonicalSkillName(name: unknown): name is string {
  return typeof name === 'string' && CANONICAL_SKILL_NAME.test(name) && isSafeSkillName(name);
}
