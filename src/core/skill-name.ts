import { basename, posix, win32 } from 'node:path';

export function isSafeSkillName(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  if (name.length === 0) return false;
  if (name.includes('\0')) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (posix.isAbsolute(name) || win32.isAbsolute(name)) return false;
  if (name === '.' || name === '..' || name.startsWith('.')) return false;
  return basename(name) === name;
}

export function assertSafeSkillName(name: unknown, context = 'skill name'): asserts name is string {
  if (!isSafeSkillName(name)) {
    throw new Error(`Unsafe ${context}: ${JSON.stringify(name)}`);
  }
}
