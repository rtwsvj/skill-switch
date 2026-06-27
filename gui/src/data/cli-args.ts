interface InstallArgsRequest {
  source: string;
  agent: string;
  mode: 'copy' | 'symlink';
  skill?: string;
  ref?: string;
  force?: boolean;
  forceReason?: string;
}

interface ToggleArgsRequest {
  name: string;
  enabled: boolean;
}

interface SyncArgsRequest {
  dryRun: boolean;
}

interface RemoveArgsRequest {
  name: string;
  agent: string;
}

interface RestoreArgsRequest {
  id?: string;
  latest?: boolean;
}

export function installArgs(request: InstallArgsRequest): string[] {
  const args = [
    'install',
    request.source,
    '--agent',
    request.agent,
    '--mode',
    request.mode,
  ];
  if (request.skill) args.push('--skill', request.skill);
  if (request.ref) args.push('--ref', request.ref);
  if (request.force) args.push('--force');
  if (request.force && request.forceReason?.trim()) args.push('--force-reason', request.forceReason.trim());
  args.push('--json');
  return args;
}

export function toggleArgs(request: ToggleArgsRequest): string[] {
  return ['toggle', request.name, request.enabled ? '--on' : '--off', '--json'];
}

export function syncArgs(request: SyncArgsRequest): string[] {
  return request.dryRun ? ['sync', '--dry-run', '--json'] : ['sync', '--json'];
}

export function removeArgs(request: RemoveArgsRequest): string[] {
  return ['remove', request.name, '--agent', request.agent, '--json'];
}

export function restoreArgs(request: RestoreArgsRequest): string[] {
  if (request.latest) return ['restore', '--latest', '--json'];
  if (request.id) return ['restore', '--id', request.id, '--json'];
  return ['restore', '--json'];
}

interface AddInstallArgsRequest {
  raw: string;
  skills: string[];
  agent: string;
  mode?: 'copy' | 'symlink';
  force?: boolean;
  forceReason?: string;
}

/** add 预览(只解析+审计,绝不安装):add <raw> --dry-run --json */
export function addPreviewArgs(raw: string): string[] {
  return ['add', raw, '--dry-run', '--json'];
}

/** add 安装选中的 skill:add <raw> --agent X --skill a --skill b … --json */
export function addInstallArgs(request: AddInstallArgsRequest): string[] {
  const args = ['add', request.raw, '--agent', request.agent];
  for (const s of request.skills) args.push('--skill', s);
  if (request.mode) args.push('--mode', request.mode);
  if (request.force) args.push('--force');
  if (request.force && request.forceReason?.trim()) {
    args.push('--force-reason', request.forceReason.trim());
  }
  args.push('--json');
  return args;
}
