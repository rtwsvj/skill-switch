import scan from '../../fixtures/scan.json';
import audit from '../../fixtures/audit.json';
import doctor from '../../fixtures/doctor.json';
import stats from '../../fixtures/stats.json';
import lockVerify from '../../fixtures/lock-verify.json';
import { assembleDashboard, emptyStats } from './dashboard';
import type {
  AddCliResult,
  AddInstallRequest,
  AuditReport,
  CliJsonResult,
  ConfigAuditReport,
  DashboardData,
  DoctorReport,
  InstallRequest,
  InstallRunResult,
  LockVerifyReport,
  RemoveRequest,
  RemoveRunResult,
  RestoreListResult,
  RestoreRequest,
  RestoreRunResult,
  ScanReport,
  StatsReport,
  SyncRequest,
  SyncRunResult,
  ToggleRequest,
  ToggleRunResult,
} from './types';

function fixtureResult<T>(data: T): CliJsonResult<T> {
  return {
    data,
    stdout: `${JSON.stringify(data, null, 2)}\n`,
    stderr: '',
    exitCode: 0,
  };
}

export async function loadScan(): Promise<ScanReport> {
  return scan as ScanReport;
}

export async function loadAudit(): Promise<AuditReport[]> {
  return audit as AuditReport[];
}

export async function loadDoctor(): Promise<DoctorReport> {
  return doctor as DoctorReport;
}

export async function loadStats(): Promise<StatsReport> {
  return stats as StatsReport;
}

export async function loadLockVerify(): Promise<LockVerifyReport> {
  return lockVerify as LockVerifyReport;
}

export async function loadConfigAudit(): Promise<ConfigAuditReport> {
  // 样例数据:展示一条 MCP 发现 + 一条干净的 settings 文件。
  return {
    home: '/fixtures/home',
    total: 0,
    skills: [],
    configs: [
      {
        absPath: '/fixtures/home/.claude/settings.json',
        relPath: '.claude/settings.json',
        findings: [],
      },
      {
        absPath: '/fixtures/home/.claude/mcp.json',
        relPath: '.claude/mcp.json',
        findings: [
          {
            ruleId: 'mcp-remote-url-command',
            severity: 'high',
            file: '.claude/mcp.json',
            line: 5,
            excerpt: '"url": "https://evil.example.com/mcp"',
            message: 'MCP server points to a remote URL — verify you trust this endpoint.',
          },
        ],
      },
    ],
    configsBlocked: true,
  };
}

export async function loadDashboardData(): Promise<DashboardData> {
  const [scan, audit, doctor, stats, lockVerify] = await Promise.allSettled([
    loadScan(),
    loadAudit(),
    loadDoctor(),
    loadStats(),
    loadLockVerify(),
  ]);

  return assembleDashboard({ scan, audit, doctor, stats, lockVerify }, 'fixtures');
}

export async function loadCoreDashboard(): Promise<DashboardData> {
  // M0-5.6 懒加载:与 tauri 适配器一致 —— 首屏只 scan/doctor/lock,audit/stats 后台懒加载。
  const [scanResult, doctorResult, lockResult] = await Promise.allSettled([
    loadScan(),
    loadDoctor(),
    loadLockVerify(),
  ]);

  return assembleDashboard(
    {
      scan: scanResult,
      doctor: doctorResult,
      lockVerify: lockResult,
      audit: { status: 'fulfilled', value: [] },
      stats: { status: 'fulfilled', value: emptyStats },
    },
    'fixtures',
  );
}

export async function runInstall(request: InstallRequest): Promise<CliJsonResult<InstallRunResult>> {
  const data: InstallRunResult = {
    installed: [{ name: request.skill ?? 'fixture-skill', targetPath: `/fixtures/${request.agent}` }],
    blocked: [],
    snapshotPath: '/fixtures/backups/pre-install.tar.gz',
    lockPath: '/fixtures/.skill-switch/skills.lock.json',
    declarationPath: '/fixtures/.skill-switch/skills.json',
  };
  return fixtureResult(data);
}

export async function runToggle(request: ToggleRequest): Promise<CliJsonResult<ToggleRunResult>> {
  return fixtureResult({
    name: request.name,
    enabled: request.enabled,
    declarationPath: '/fixtures/.skill-switch/skills.json',
    snapshots: [],
    actions: [{ kind: request.enabled ? 'create' : 'remove', agent: 'claude-code', name: request.name, target: `/fixtures/${request.name}` }],
  });
}

export async function runSync(request: SyncRequest): Promise<CliJsonResult<SyncRunResult>> {
  return fixtureResult({
    declarationPath: '/fixtures/.skill-switch/skills.json',
    dryRun: request.dryRun,
    snapshots: request.dryRun ? [] : [{ path: '/fixtures/backups/pre-sync.tar.gz', label: 'pre-sync', createdAt: new Date().toISOString() }],
    actions: [{ kind: 'noop', agent: 'claude-code', name: 'fixture-skill', target: '/fixtures/fixture-skill' }],
  });
}

export async function runRemove(request: RemoveRequest): Promise<CliJsonResult<RemoveRunResult>> {
  return fixtureResult({
    name: request.name,
    agent: request.agent,
    targetPath: `/fixtures/${request.agent}/${request.name}`,
    lockPath: '/fixtures/.skill-switch/skills.lock.json',
    declarationPath: '/fixtures/.skill-switch/skills.json',
    snapshots: [{ path: '/fixtures/backups/pre-remove.tar.gz', label: 'pre-remove', createdAt: new Date().toISOString() }],
  });
}

export async function runRestore(
  request: RestoreRequest = {},
): Promise<CliJsonResult<RestoreListResult | RestoreRunResult>> {
  if (request.id || request.latest) {
    return fixtureResult({
      restored: true,
      target: '/fixtures/.claude/skills',
      snapshot: { id: request.id ?? 'latest', path: '/fixtures/backups/snapshot.tar.gz', label: 'pre-toggle', createdAt: new Date().toISOString(), sourceDir: '/fixtures/.claude/skills' },
      safetySnapshot: { path: '/fixtures/backups/pre-restore.tar.gz', label: 'pre-restore', createdAt: new Date().toISOString(), sourceDir: '/fixtures/.claude/skills' },
    });
  }
  return fixtureResult({
    store: '/fixtures/.skill-switch/backups',
    snapshots: [{ id: '1', path: '/fixtures/backups/snapshot.tar.gz', label: 'pre-toggle', createdAt: new Date().toISOString(), sourceDir: '/fixtures/.claude/skills' }],
  });
}

// ── 「一键安装」(add)demo:演示模式给假数据,不联网、不写盘 ──────────────────
export async function previewAdd(raw: string): Promise<AddCliResult> {
  const trimmed = raw.trim();
  // 演示:危险执行形态 → 拒绝
  if (/\|\s*(ba)?sh\b|<\(\s*(curl|wget)|\bsudo\b|\beval\b/.test(trimmed) || /^(curl|wget|bash|sh)\b/.test(trimmed)) {
    return {
      preview: {
        parsed: { kind: 'unsupported', raw: trimmed },
        candidates: [],
        error: '这是一条会「下载并执行」的命令。skill-switch 绝不执行任意命令(演示模式)。',
      },
      installed: [],
      error: '这是一条会「下载并执行」的命令。skill-switch 绝不执行任意命令(演示模式)。',
    };
  }
  // 演示:任何看起来像来源的输入 → 给两个候选(一安全一危险)
  return {
    preview: {
      parsed: {
        kind: 'github-url',
        raw: trimmed,
        gitSource: 'https://github.com/example/skills.git',
      },
      candidates: [
        { name: 'tidy-notes', relPath: 'tidy-notes', verdict: 'SAFE', score: 100, blocked: false, findings: [] },
        {
          name: 'remote-debug',
          relPath: 'remote-debug',
          verdict: 'DANGER',
          score: 20,
          blocked: true,
          findings: [{ ruleId: 'reverse-shell/dev-tcp', severity: 'critical', message: '反向 shell:/dev/tcp 重定向' }],
        },
      ],
    },
    installed: [],
    note: 'preview-only',
  };
}

export async function runAdd(request: AddInstallRequest): Promise<CliJsonResult<AddCliResult>> {
  const installable = request.skills.filter((s) => s !== 'remote-debug' || request.force);
  const blocked = request.skills.filter((s) => s === 'remote-debug' && !request.force);
  const preview = (await previewAdd(request.raw)).preview;
  return fixtureResult({
    preview,
    installed: installable.map((name) => ({ name, targetPath: `/fixtures/${request.agent}/${name}` })),
    blocked: blocked.map((name) => ({ name, score: 20 })),
  });
}
