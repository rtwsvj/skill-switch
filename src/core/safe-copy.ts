import { copyFile, lstat, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function copyDirWithoutSymlinks(source: string, target: string): Promise<void> {
  const info = await lstat(source);
  if (info.isSymbolicLink()) return;

  if (info.isFile()) {
    await mkdir(join(target, '..'), { recursive: true });
    await copyFile(source, target);
    return;
  }

  if (!info.isDirectory()) return;

  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    await copyDirWithoutSymlinks(join(source, entry.name), join(target, entry.name));
  }
}
