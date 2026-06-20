// P2-1:doctor 文件夹哈希缓存。doctor 在每次运行(GUI 仪表盘热加载路径)对每个
// enabled skill×agent 都重算一次 computeSkillFolderHash(target)——递归读全部文件 + sha256,
// 在热加载路径上偏贵。本缓存用一个"廉价的 stat 签名"做命中判定:
//   键   = 目标目录的廉价 stat 签名(对每个文件取 relativePath+size+mtimeMs+ctimeMs,排序后串成一行;只 stat,不读内容)
//   值   = 上次对该签名算出的文件夹 sha256
// 命中(签名一致)即复用缓存里的 sha256,跳过昂贵的"读全部内容 + 哈希"。
//
// 安全约束:doctor 是完整性/安全校验,缓存绝不能造成假"无漂移"。签名涵盖任一文件的
// size / mtime / ctime 变化(编辑、重装、git checkout 都会改 mtime 与 ctime),变了就重算真哈希。
// drift 判定结果与不开缓存逐字节一致 —— 缓存只改变"怎么拿到哈希",不改变结论。
//
// 为什么也带 ctime:`touch -r`(或保留时间戳的 rsync)能回填 atime/mtime,却**改不了 ctime**——
// 任何内容写入都会把 ctime 刷新到当前时刻。所以"同长度替换 + 回填 mtime"这种刻意篡改虽瞒过
// size+mtime,仍会改变 ctime → 签名变 → 重算真哈希,漂移照样被发现。残留边界仅剩"连 ctime 也
// 被伪造"(需改系统时钟/特权操作,普通 touch 达不到),实务上可忽略。
//
// 缓存是可丢弃的派生数据:读/写任何环节失败一律降级到现算(fresh compute),绝不让缓存
// 错误打断 doctor / doctor --ci(纯优化,不影响正确性)。
import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { computeSkillFolderHash } from '../vendor/vercel-skills/local-lock.ts';
import { readJsonState, writeJsonState } from './state-io.ts';

export interface DoctorHashCacheEntry {
  /** 目标目录的廉价 stat 签名(见 computeStatSignature)。 */
  signature: string;
  /** 该签名对应的、上次算出的文件夹 sha256(computeSkillFolderHash 的结果)。 */
  hash: string;
}

export interface DoctorHashCacheFile {
  version: 1;
  /** 键为目标目录的绝对路径(<skillsDir>/<name>)。 */
  entries: Record<string, DoctorHashCacheEntry>;
}

const EMPTY: DoctorHashCacheFile = { version: 1, entries: {} };

export function getDoctorHashCachePath(home: string): string {
  return join(home, '.skill-switch', 'doctor-hash-cache.json');
}

/**
 * 读缓存。损坏 / 结构非法 / 任何 IO 错误一律当空重建 —— 派生数据,绝不致命。
 * (与 stats-cache 同策略:容忍读,坏了就退回空。)
 */
export async function readDoctorHashCache(home: string): Promise<DoctorHashCacheFile> {
  try {
    const data = await readJsonState<DoctorHashCacheFile>(getDoctorHashCachePath(home), EMPTY);
    if (data && typeof data === 'object' && data.entries && typeof data.entries === 'object') {
      return data;
    }
  } catch {
    // 缓存损坏 / 权限 / 其它 IO 错误 → 重建空,不致命。
  }
  return { version: 1, entries: {} };
}

/** 写缓存(原子 + 0o600,经 writeJsonState)。调用方负责吞掉异常以保证纯优化语义。 */
export async function writeDoctorHashCache(home: string, cache: DoctorHashCacheFile): Promise<void> {
  await writeJsonState(getDoctorHashCachePath(home), cache);
}

/**
 * 计算目标目录的廉价 stat 签名:对目录内每个文件取 (relativePath, size, mtimeMs, ctimeMs),
 * 按 relativePath 排序后串成确定性字符串。只 stat,不读任何文件内容。
 *
 * 目录遍历规则与 computeSkillFolderHash 对齐(同样跳过 .git / node_modules),
 * 以保证"签名覆盖的文件集合"与"被哈希的文件集合"一致。
 */
export async function computeStatSignature(dir: string): Promise<string> {
  const parts: string[] = [];
  await collectStats(dir, dir, parts);
  parts.sort();
  return parts.join('\n');
}

async function collectStats(baseDir: string, currentDir: string, results: string[]): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') return;
        await collectStats(baseDir, fullPath, results);
      } else if (entry.isFile()) {
        const st = await stat(fullPath);
        const relativePath = relative(baseDir, fullPath).split('\\').join('/');
        results.push(`${relativePath}\u0000${st.size}\u0000${st.mtimeMs}\u0000${st.ctimeMs}`);
      }
    }),
  );
}

/**
 * 取目标目录的文件夹 sha256:廉价 stat 签名命中缓存则复用,否则现算 computeSkillFolderHash。
 * 把(可能更新过的)缓存条目写回传入的 cache.entries(调用方在最后一次性原子落盘)。
 *
 * 注意:本函数本身不读旧缓存以外的任何来源,且签名失败会向上抛 —— 由调用方决定降级策略。
 */
export async function resolveFolderHash(
  cache: DoctorHashCacheFile,
  target: string,
): Promise<string> {
  const signature = await computeStatSignature(target);
  const cached = cache.entries[target];
  if (cached && cached.signature === signature) {
    return cached.hash; // 命中:size/mtime/路径全未变 → 复用,跳过内容读+哈希。
  }
  const hash = await computeSkillFolderHash(target);
  cache.entries[target] = { signature, hash };
  return hash;
}
