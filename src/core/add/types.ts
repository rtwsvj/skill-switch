// 「一键安装」(add)特性的共享契约。
//
// 安全姿态(已与用户敲定):绝不执行任何粘贴的命令,只从输入里**抽出 git 来源**,
// 再走 skill-switch 现有的「克隆(只读)→ 审计 → 安全才落地」管线。

/** 解析出的输入种类。 */
export type ParsedSourceKind =
  | 'github-url' // https://github.com/owner/repo[/tree/<ref>/<subdir>]
  | 'git-url' // 任意 https/.git/file:// git 源(含 git@…:owner/repo)
  | 'git-clone' // `git clone <url> [dir]`
  | 'npm' // `npx <pkg>` / `npm i <pkg>`(包名,需 registry 解析成仓库)
  | 'unsupported'; // curl|bash、裸命令等无法静态审计的形态 → 拒绝

/** 把一段粘贴内容解析成的规范化来源。纯结果,无副作用。 */
export interface ParsedSource {
  kind: ParsedSourceKind;
  /** 原始输入(原样保留,便于展示)。 */
  raw: string;
  /**
   * 规范化的 git 源,可直接喂 installFromSource / cloneRepo。
   * unsupported 时为空;npm 时需先经 resolveNpmPackage 填充。
   */
  gitSource?: string;
  /** 分支 / tag / commit。 */
  ref?: string;
  /** 仓库内子目录(GitHub /tree/<ref>/<subdir> 链接);只装该子目录里的 skill。 */
  subdir?: string;
  /** npm 包名(kind === 'npm' 时)。 */
  npmPackage?: string;
  /** 给用户看的说明 / 拒绝原因(unsupported 时必有)。 */
  note?: string;
  /** 来源可信度提示(如 npm 包发布内容可能 ≠ 源码仓库)。 */
  provenanceWarning?: string;
}

/** 审计裁决(与 audit 引擎一致)。 */
export type AddVerdict = 'SAFE' | 'REVIEW' | 'DANGER';

/** 来源里发现的一个候选 skill(已审计)。 */
export interface SkillCandidate {
  /** skill 目录名(= 安装后的名字)。 */
  name: string;
  /** 相对克隆根的路径。 */
  relPath: string;
  /** 审计裁决。 */
  verdict: AddVerdict;
  /** 审计评分(0–100)。 */
  score: number;
  /** 是否会被安全闸门拦下(危险源默认不装,需显式放行)。 */
  blocked: boolean;
  /** 命中的风险点 —— 内容安全:只含 ruleId / 严重度 / 信息,绝不回显命中行文或密钥。 */
  findings: Array<{ ruleId: string; severity: string; message: string }>;
}

/** 解析 + 克隆 + 审计后的预览结果(给用户挑选用;不含任何写动作)。 */
export interface AddPreview {
  parsed: ParsedSource;
  /** 候选 skill 列表(已逐个审计);unsupported / 解析失败时为空。 */
  candidates: SkillCandidate[];
  /** 出错原因(unsupported、克隆失败、来源里没有 skill 等)。有值即 candidates 为空。 */
  error?: string;
}
