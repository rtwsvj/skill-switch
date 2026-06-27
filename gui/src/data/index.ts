import * as fixtures from './fixtures';
import type { DashboardData } from './types';

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function activeAdapter() {
  if (isTauriRuntime()) {
    return import('./tauri');
  }
  return fixtures;
}

export async function loadScan() {
  return (await activeAdapter()).loadScan();
}

export async function loadAudit() {
  return (await activeAdapter()).loadAudit();
}

export async function loadDoctor() {
  return (await activeAdapter()).loadDoctor();
}

export async function loadStats() {
  return (await activeAdapter()).loadStats();
}

export async function loadLockVerify() {
  return (await activeAdapter()).loadLockVerify();
}

export async function loadConfigAudit() {
  return (await activeAdapter()).loadConfigAudit();
}

export async function loadDashboardData(): Promise<DashboardData> {
  return (await activeAdapter()).loadDashboardData();
}

export async function loadCoreDashboard(): Promise<DashboardData> {
  return (await activeAdapter()).loadCoreDashboard();
}

export async function runInstall(...args: Parameters<typeof fixtures.runInstall>) {
  return (await activeAdapter()).runInstall(...args);
}

export async function previewAdd(...args: Parameters<typeof fixtures.previewAdd>) {
  return (await activeAdapter()).previewAdd(...args);
}

export async function runAdd(...args: Parameters<typeof fixtures.runAdd>) {
  return (await activeAdapter()).runAdd(...args);
}

export async function runToggle(...args: Parameters<typeof fixtures.runToggle>) {
  return (await activeAdapter()).runToggle(...args);
}

export async function runSync(...args: Parameters<typeof fixtures.runSync>) {
  return (await activeAdapter()).runSync(...args);
}

export async function runRemove(...args: Parameters<typeof fixtures.runRemove>) {
  return (await activeAdapter()).runRemove(...args);
}

export async function runRestore(...args: Parameters<typeof fixtures.runRestore>) {
  return (await activeAdapter()).runRestore(...args);
}

export type {
  AuditCoverage,
  AuditFinding,
  AuditReport,
  AuditSeverity,
  AuditVerdict,
  BypassRecord,
  CliJsonResult,
  ConfigAuditReport,
  ConfigFileResult,
  DashboardData,
  DoctorDeclaration,
  DoctorFinding,
  DoctorReport,
  InstallMode,
  InstallRequest,
  InstallRunResult,
  LockVerifyEntry,
  LockVerifyReport,
  RemoveRequest,
  RemoveRunResult,
  RestoreListResult,
  RestoreRequest,
  RestoreRunResult,
  ScanReport,
  SkillRecord,
  StatsReport,
  SyncAction,
  SyncRequest,
  SyncRunResult,
  ToggleRequest,
  ToggleRunResult,
} from './types';
