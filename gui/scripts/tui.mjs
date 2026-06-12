#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const cliPrefix = ['--import', 'tsx', 'src/cli/index.ts'];
const maxBuffer = 16 * 1024 * 1024;

const views = ['overview', 'scan', 'audit', 'doctor', 'stats'];
let activeView = 'overview';
let state = null;

function blockable(report) {
  return report.score < 70 || report.findings.some((finding) => finding.severity === 'critical' || finding.severity === 'high');
}

async function runCli(args, allowNonZero = false) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [...cliPrefix, ...args], {
      cwd: repoRoot,
      env: { ...process.env, PAGER: '', GIT_PAGER: '' },
      maxBuffer,
    });
    return JSON.parse(stdout);
  } catch (error) {
    if (allowNonZero && error.stdout) return JSON.parse(error.stdout);
    const stderr = error.stderr || error.message || String(error);
    throw new Error(`skill-switch ${args.join(' ')} failed: ${stderr.trim()}`);
  }
}

function skillFolder(skill) {
  return skill.path.endsWith('/SKILL.md') ? skill.path.slice(0, -'/SKILL.md'.length) : skill.path;
}

async function loadData() {
  const scan = await runCli(['scan', '--json']);
  const [doctor, stats, audits] = await Promise.all([
    runCli(['doctor', '--json']),
    runCli(['stats', '--days', '30', '--json']),
    Promise.all(
      scan.skills.map(async (skill) => {
        const report = await runCli(['audit', skillFolder(skill), '--json'], true);
        return {
          ...report,
          name: skill.name ?? skill.dirName,
          dirName: skill.dirName,
          relSkillsDir: skill.relSkillsDir,
          agents: skill.agents,
          blocked: blockable(report),
        };
      }),
    ),
  ]);
  return {
    scan,
    doctor,
    stats,
    audits,
    loadedAt: new Date().toISOString(),
  };
}

function trim(text, max = 88) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function line(char = '-', width = 100) {
  return char.repeat(width);
}

function formatOverview(data) {
  const agents = new Set(data.scan.skills.flatMap((skill) => skill.agents));
  const risky = data.audits.filter((audit) => audit.blocked);
  return [
    'skill-switch TUI / read-only live view',
    line('='),
    `loaded: ${data.loadedAt}`,
    `agents: ${agents.size} | skills: ${data.scan.total} | zombies: ${data.stats.zombies.length} | doctor: ${data.doctor.clean ? 'clean' : `${data.doctor.findings.length} findings`} | audit blocks: ${risky.length}`,
    '',
    'keys: 1 overview  2 scan  3 audit  4 doctor  5 stats  r refresh  q quit',
  ].join('\n');
}

function formatScan(data) {
  const rows = data.scan.skills.map((skill) => {
    const flags = [
      skill.error ? 'parse-error' : '',
      skill.name && skill.name !== skill.dirName ? 'name-mismatch' : '',
    ].filter(Boolean);
    return `${skill.dirName.padEnd(28)} ${(skill.name ?? '-').padEnd(28)} ${skill.agents.join(',').padEnd(34)} ${flags.join(',') || 'ok'}`;
  });
  return ['SCAN', line('='), 'directory                    name                         agents                             status', line(), ...rows].join('\n');
}

function formatAudit(data) {
  const rows = [...data.audits]
    .sort((a, b) => Number(b.blocked) - Number(a.blocked) || a.score - b.score)
    .map((audit) => {
      const topFinding = audit.findings[0] ? `${audit.findings[0].severity}:${audit.findings[0].ruleId}` : 'clean';
      const status = audit.blocked ? 'BLOCK' : 'pass';
      return `${audit.name.padEnd(30)} ${String(audit.score).padStart(3)} ${audit.verdict.padEnd(7)} ${status.padEnd(6)} ${trim(topFinding, 48)}`;
    });
  return ['AUDIT', line('='), 'skill                          scr verdict status finding', line(), ...rows].join('\n');
}

function formatDoctor(data) {
  if (data.doctor.clean) {
    return ['DOCTOR', line('='), `clean: declared=${data.doctor.checked.declared} locked=${data.doctor.checked.locked}`].join('\n');
  }
  return [
    'DOCTOR',
    line('='),
    ...data.doctor.findings.map((finding) => `${finding.kind.padEnd(16)} ${finding.agent}/${finding.name} ${trim(finding.detail)}`),
  ].join('\n');
}

function formatStats(data) {
  const usage = data.stats.usage.length > 0
    ? data.stats.usage.map((item) => `${String(item.count).padStart(4)} ${item.skill.padEnd(32)} ${item.lastUsed ?? '-'}`)
    : ['no skill invocations in the selected window'];
  const zombies = data.stats.zombies.map((zombie) => `zombie ${zombie.name.padEnd(30)} ${zombie.agents.join(',')} (${zombie.relSkillsDir})`);
  return [
    'STATS',
    line('='),
    `transcripts=${data.stats.scannedFiles} invocations=${data.stats.invocations} since=${data.stats.since ?? 'all-time'}`,
    '',
    ...usage,
    '',
    ...zombies,
  ].join('\n');
}

function render(view, data) {
  if (view === 'scan') return formatScan(data);
  if (view === 'audit') return formatAudit(data);
  if (view === 'doctor') return formatDoctor(data);
  if (view === 'stats') return formatStats(data);
  return formatOverview(data);
}

function draw() {
  process.stdout.write('\x1b[2J\x1b[H');
  process.stdout.write(`${render(activeView, state)}\n`);
}

async function refresh() {
  state = await loadData();
  draw();
}

async function snapshot(file) {
  const data = await loadData();
  const output = views.map((view) => render(view, data)).join(`\n\n${line('#')}\n\n`);
  if (file) {
    await mkdir(dirname(resolve(file)), { recursive: true });
    await writeFile(file, `${output}\n`, 'utf8');
  }
  process.stdout.write(`${output}\n`);
}

function parseArgs(argv) {
  const args = { snapshot: false, file: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--snapshot') args.snapshot = true;
    if (argv[i] === '--snapshot-file') {
      args.snapshot = true;
      args.file = argv[i + 1] ?? '';
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.snapshot || !process.stdin.isTTY) {
  await snapshot(args.file);
  process.exit(0);
}

readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);

process.stdin.on('keypress', async (_str, key) => {
  if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
    process.stdout.write('\n');
    process.exit(0);
  }
  if (key.name === 'r') {
    await refresh();
    return;
  }
  const index = Number(key.name) - 1;
  if (Number.isInteger(index) && views[index]) {
    activeView = views[index];
    draw();
  }
});

await refresh();
