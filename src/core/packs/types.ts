// 套餐(pack)特性的共享类型契约 —— 三个并行子任务都依赖这里的接口:
//   Step1 共现分析(cooccurrence.ts)  → 产出 CooccurrenceReport
//   Step2 建议生成(suggest.ts)       → 消费 CooccurrenceReport,产出 PackSuggestion[]
//   Step3 套餐模型(pack-model.ts)     → 把 PackSuggestion / 手动精选 → PackManifest 并落地
//
// 设计定稿(经与用户问答确定):
//   - v1「一起用」单位 = 同一次对话(同一个 session 文件)里的共现。
//   - 只数 skill 名 + 次数,绝不读对话正文、绝不出本机(延续零遥测定位)。
//   - 只建议,用户确认才落地。
//   - 手动精选包 与 用法发现包 = 同一个套餐模型(PackManifest),两个入口(source 字段区分)。
//   - 套餐要能:跨机重装、多 agent 同步、分享给别人(故 PackSkillRef 带来源+commit)。

// ── Step1:使用统计 + 共现 ─────────────────────────────────────────────────────

/** 单个 skill 在窗口内的使用统计(来自 transcripts) */
export interface SkillUsageStat {
  skill: string;
  /** 触发总次数(窗口内) */
  count: number;
  /** 出现在多少个不同 session 里 */
  sessions: number;
}

/** 一对 skill 在同一 session 内的共现 */
export interface SkillCooccurrence {
  a: string;
  b: string;
  /** 一起出现在多少个 session */
  sessionsTogether: number;
  /** 共现强度 = sessionsTogether / min(sessions(a), sessions(b)),0..1;越接近 1 越是"老搭子" */
  strength: number;
}

/** Step1 产物:共现分析报告 */
export interface CooccurrenceReport {
  /** 分析窗口(天);未设 = 全量 */
  windowDays?: number;
  /** 纳入分析的 session 总数 */
  sessionCount: number;
  /** 每个 skill 的用法,按 count 降序 */
  usage: SkillUsageStat[];
  /** 两两共现,按 strength 降序 */
  pairs: SkillCooccurrence[];
}

// ── Step2:建议套餐 ────────────────────────────────────────────────────────────

/** Step2 产物:一个建议套餐(只建议,不落地) */
export interface PackSuggestion {
  /** 稳定 id(由 skills 排序后派生,便于"采纳哪一个") */
  id: string;
  /** 自动起的名字(用户可改) */
  suggestedName: string;
  /** 组内 skill 名 */
  skills: string[];
  /** 人类可读理由,含真实数字(如"过去30天,这4个在23次对话里一起出现") */
  rationale: string;
  /** 组内平均共现强度,0..1 */
  strength: number;
}

// ── Step3:套餐清单(可携带 / 可分享 / 可装) ────────────────────────────────────

/** 套餐里一个 skill 的引用 —— 带来源信息,供重装/分享 */
export interface PackSkillRef {
  name: string;
  /** 上游仓库(git URL);本地来源可空 */
  repo?: string;
  commit?: string;
  ref?: string;
}

/** 套餐清单(pack.json 的结构):手动精选与用法发现汇成此一个模型 */
export interface PackManifest {
  version: 1;
  name: string;
  displayName?: string;
  description?: string;
  /** 两个入口汇成一个模型:manual=手动精选,discovered=从对话用法发现 */
  source: 'manual' | 'discovered';
  skills: PackSkillRef[];
  /** 继承:父套餐清单的路径数组,按声明顺序展开;父在前,子同名 skill 覆盖父。安装/show 时解析。 */
  extends?: string[];
  /** ISO 时间;discovered 包可记录基于哪段窗口的用法 */
  createdAt?: string;
}
