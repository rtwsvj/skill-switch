import type {
  DashboardData,
  InstallMode,
  InstallRunResult,
  RestoreListResult,
  SkillRecord,
  SyncRunResult,
} from '../data';

export type Screen = 'overview' | 'skills' | 'audit' | 'history' | 'stats';

// M0-5.6 懒加载:audit/stats/configAudit 这几个重区块按需加载,
// 每个区块有独立状态机:idle 未触发 / loading 加载中 / loaded 成功 / error 失败。
export type SectionName = 'audit' | 'stats' | 'configAudit';
export type SectionStatus = 'idle' | 'loading' | 'loaded' | 'error';
export interface SectionState {
  status: SectionStatus;
  loadedAt?: string;
  error?: string;
}
export type SectionStates = Record<SectionName, SectionState>;

export interface OperationNotice {
  tone: 'good' | 'warn' | 'danger';
  title: string;
  detail?: string;
  snapshots?: string[];
}

export interface ConfirmationDialogRequest {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  tone?: 'warn' | 'danger';
  /** F-B2:大白话后果/安心提示(如「已自动备份,可在『历史』还原」),直击 P6 怕翻车。 */
  consequence?: string;
  /** F-A2:结构化「将发生什么」预览(每行一条大白话,如「新建 claude-code / foo」)。 */
  details?: string[];
  onConfirm: () => void | Promise<void>;
}

export interface WriteConfirmationRequest {
  message: string;
  tone?: 'warn' | 'danger';
  consequence?: string;
  details?: string[];
  onConfirm: () => void | Promise<void>;
}

export interface ConfirmationDialogState {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  tone: 'warn' | 'danger';
  consequence?: string;
  details?: string[];
  onConfirm: () => Promise<void>;
  onCancel: () => Promise<void>;
}

export interface InstallDraft {
  source: string;
  agent: string;
  mode: InstallMode;
  skill: string;
  ref: string;
  force: boolean;
}

export interface WriteOperationsProps {
  data: DashboardData;
  busy: string | null;
  installDraft: InstallDraft;
  installResult: InstallRunResult | null;
  syncPlan: SyncRunResult | null;
  restoreList: RestoreListResult | null;
  onInstallDraftChange: (draft: InstallDraft) => void;
  onInstall: () => void;
  onSyncDryRun: () => void;
  onSyncApply: () => void;
  onLoadSnapshots: () => void;
  onRestore: (id: string) => void;
  blockedReason: string;
  onBlockedReasonChange: (value: string) => void;
  onForceInstall: () => void;
}

export interface SkillActionsProps {
  busy: string | null;
  onToggle: (skill: SkillRecord, enabled: boolean) => void;
  onRemove: (skill: SkillRecord) => void;
  importableCount: number;
  onImportExisting: () => void;
}
