// drift-approvals:cargo-vet 式逐条审批——把已知/已接受的漂移记录下来,
// 让 `drift --ci` 不再对已审批项报错。
//
// 存储位置:<home>/.skill-switch/drift-approvals.json
// 存储内容:内容哈希(不含原文);审批身份 = "<skill>::<kind>"(kind 派生自 DriftState);
//   当内容再次变化时,哈希不匹配 → 审批自动失效,重新浮出。
//
// 安全纪律:只存 SHA-256 哈希,不存 skill 原文。
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { DriftEntry, DriftState } from './drift.ts';
import { readJsonState, writeJsonState } from './state-io.ts';

// ─── 审批 criteria 分级 ───────────────────────────────────────────────────────
//
// criteria 字段表明此审批满足的安全基线等级:
//   safe-to-run    — 仅确认可安全运行(默认级别,与旧版行为一致)
//   safe-to-deploy — 确认可安全部署到生产(更高要求)
//
// drift --ci --criteria safe-to-deploy 只认达到 safe-to-deploy 级别的审批;
// 不带 --criteria 时行为与旧版完全一致(任何审批均有效)。
export type ApprovalCriteria = 'safe-to-run' | 'safe-to-deploy';

// ─── 存储结构 ──────────────────────────────────────────────────────────────────

export interface ApprovalRecord {
  /** 批准时的内容状态哈希(= DriftEntry 内容指纹,见 driftContentHash) */
  contentHash: string;
  /** ISO-8601 批准时间 */
  approvedAt: string;
  /** 可选说明 */
  note?: string;
  /**
   * 审批达到的安全基线等级(可选,缺省等同于 safe-to-run)。
   * 新增字段,旧记录无此字段时降级为 safe-to-run。
   */
  criteria?: ApprovalCriteria;
}

export interface DriftApprovalsFile {
  version: 1;
  /** key = "<agent>::<name>::<kind>",value = 审批记录 */
  approvals: Record<string, ApprovalRecord>;
}

// ─── 路径 ─────────────────────────────────────────────────────────────────────

export function getDriftApprovalsPath(home: string): string {
  return join(home, '.skill-switch', 'drift-approvals.json');
}

// ─── 身份与哈希键 ─────────────────────────────────────────────────────────────

/**
 * 审批身份键:agent + name + kind(漂移类型)三元组,人类可读且在 JSON 里稳定。
 * kind 直接取自 DriftState,让"上游前进"和"本地修改"各自独立审批。
 */
export function approvalKey(entry: DriftEntry): string {
  const kind = driftKind(entry);
  return `${entry.agent}::${entry.name}::${kind}`;
}

/**
 * 从 DriftEntry 派生可区分的漂移类型字符串。
 * in-sync / unknown 不应该被审批,但允许存储(不会造成副作用)。
 */
function driftKind(entry: DriftEntry): DriftState {
  return entry.state;
}

/**
 * 内容指纹:由 detail 文本 + lockCommit + upstreamCommit 组合而成的确定性哈希。
 * 不直接使用 sha256 文件内容哈希(那是安装产物哈希);这里捕捉的是"漂移描述本身",
 * 使得当上游再推一个 commit 时,之前对 upstream-ahead 的审批会自动失效。
 *
 * 实现:Node 内置 crypto,无新依赖。
 */
export function driftContentHash(entry: DriftEntry): string {
  // 内容指纹:state + detail + lockCommit + upstreamCommit + localSha256。
  // localSha256 在"本地内容再改"时会变 → 旧审批自动失效。
  // lockSha256 是安装时快照,不随本地修改变化,不纳入(用 localSha256 即可区分)。
  return createHash('sha256')
    .update(entry.state)
    .update('\0')
    .update(entry.detail)
    .update('\0')
    .update(entry.lockCommit ?? '')
    .update('\0')
    .update(entry.upstreamCommit ?? '')
    .update('\0')
    .update(entry.localSha256 ?? '')
    .digest('hex');
}

// ─── 读 ───────────────────────────────────────────────────────────────────────

export async function loadApprovals(home: string): Promise<DriftApprovalsFile> {
  const data = await readJsonState<DriftApprovalsFile>(getDriftApprovalsPath(home), {
    version: 1,
    approvals: {},
  });
  // 容错:结构非法时回退到空
  if (
    typeof data !== 'object' ||
    data === null ||
    typeof (data as DriftApprovalsFile).approvals !== 'object'
  ) {
    return { version: 1, approvals: {} };
  }
  return data;
}

// ─── 写:recordApproval / revokeApproval ──────────────────────────────────────

export async function recordApproval(
  home: string,
  entry: DriftEntry,
  note?: string,
  criteria?: ApprovalCriteria,
): Promise<void> {
  const store = await loadApprovals(home);
  const key = approvalKey(entry);
  store.approvals[key] = {
    contentHash: driftContentHash(entry),
    approvedAt: new Date().toISOString(),
    ...(note ? { note } : {}),
    // criteria 存在时才写入字段(向后兼容:旧记录无此字段视为 safe-to-run)
    ...(criteria ? { criteria } : {}),
  };
  await writeJsonState(getDriftApprovalsPath(home), store);
}

export async function revokeApproval(home: string, entry: DriftEntry): Promise<boolean> {
  const store = await loadApprovals(home);
  const key = approvalKey(entry);
  if (!(key in store.approvals)) return false;
  delete store.approvals[key];
  await writeJsonState(getDriftApprovalsPath(home), store);
  return true;
}

// ─── 查询:isApproved ─────────────────────────────────────────────────────────

/**
 * 当且仅当:
 *   1. approvals 中存在对应键
 *   2. 存储的 contentHash 与当前漂移项的 contentHash 完全匹配
 *   3. (可选) 若传入 requiredCriteria,审批记录的 criteria 必须达标:
 *        - safe-to-run    → 任何记录均达标(包括无 criteria 字段的旧记录)
 *        - safe-to-deploy → 仅记录中 criteria === 'safe-to-deploy' 才达标
 * 才返回 true。内容再次变化(新 commit、新本地修改)后哈希不同 → 重新浮出。
 *
 * 不传 requiredCriteria 时行为与旧版完全一致(任何审批均有效)。
 */
export function isApproved(
  store: DriftApprovalsFile,
  entry: DriftEntry,
  requiredCriteria?: ApprovalCriteria,
): boolean {
  const key = approvalKey(entry);
  const record = store.approvals[key];
  if (!record) return false;
  if (record.contentHash !== driftContentHash(entry)) return false;

  // criteria 过滤:仅当调用方要求时才检查
  if (requiredCriteria === 'safe-to-deploy') {
    // 旧记录无 criteria 字段 → 降级为 safe-to-run,不达标
    return record.criteria === 'safe-to-deploy';
  }
  // requiredCriteria 为 undefined 或 'safe-to-run' → 旧版行为,通过
  return true;
}
