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
