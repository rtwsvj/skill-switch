#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  constants,
  createReadStream,
  lstatSync,
  openSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = '@rtwsvj/skill-switch';
const ALLOWED_FORMATS = new Set(['human', 'json', 'sarif', 'github']);
const MAX_ARGS_SOURCE_LENGTH = 16 * 1024;
const MAX_ARG_COUNT = 256;
const MAX_ARG_LENGTH = 8 * 1024;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:[0-9A-Za-z-]+)(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export class ActionInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ActionInputError';
  }
}

/**
 * Parse a deliberately small shell-like quoting language into argv.
 *
 * Quotes and backslashes only group literal characters. There is no variable,
 * glob, command, process, or tilde expansion, and the result is never passed to
 * a shell.
 */
export function tokenizeExtraArgs(source) {
  if (source.length > MAX_ARGS_SOURCE_LENGTH) {
    throw new ActionInputError('args exceeds the 16 KiB limit');
  }
  if (source.includes('\0')) {
    throw new ActionInputError('args contains a NUL byte');
  }

  const args = [];
  let token = '';
  let tokenStarted = false;
  let quote = null;
  let escaping = false;

  const push = () => {
    if (!tokenStarted) return;
    if (token.length > MAX_ARG_LENGTH) {
      throw new ActionInputError('an argument exceeds the 8 KiB limit');
    }
    args.push(token);
    if (args.length > MAX_ARG_COUNT) {
      throw new ActionInputError('args contains more than 256 arguments');
    }
    token = '';
    tokenStarted = false;
  };

  for (const char of source) {
    if (escaping) {
      token += char;
      tokenStarted = true;
      escaping = false;
      continue;
    }

    if (quote === "'") {
      if (char === "'") quote = null;
      else token += char;
      tokenStarted = true;
      continue;
    }

    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === '\\') escaping = true;
      else token += char;
      tokenStarted = true;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
    } else if (char === '\\') {
      escaping = true;
      tokenStarted = true;
    } else if (/\s/u.test(char)) {
      push();
    } else {
      token += char;
      tokenStarted = true;
    }
  }

  if (escaping) throw new ActionInputError('args ends with an incomplete escape');
  if (quote !== null) throw new ActionInputError('args contains an unterminated quote');
  push();
  return args;
}

export function validateFormat(value) {
  if (!ALLOWED_FORMATS.has(value)) {
    throw new ActionInputError('format must be one of: human, json, sarif, github');
  }
  return value;
}

export function validateVersion(value) {
  if (!SEMVER.test(value)) {
    throw new ActionInputError('version must be an exact semantic version');
  }
  return value;
}

function isWithin(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot));
}

export function validateOutputPath(value, workspace) {
  if (!value || /[\0\r\n]/u.test(value)) {
    throw new ActionInputError('output must be a non-empty single-line path');
  }
  if (isAbsolute(value)) {
    throw new ActionInputError('output must be relative to GITHUB_WORKSPACE');
  }

  const absoluteWorkspace = resolve(workspace);
  const realWorkspace = realpathSync(absoluteWorkspace);
  const candidate = resolve(absoluteWorkspace, value);
  if (candidate === absoluteWorkspace || !isWithin(absoluteWorkspace, candidate)) {
    throw new ActionInputError('output must resolve to a file inside GITHUB_WORKSPACE');
  }

  const realParent = realpathSync(dirname(candidate));
  if (!isWithin(realWorkspace, realParent)) {
    throw new ActionInputError('output parent must stay inside GITHUB_WORKSPACE');
  }

  try {
    const existing = lstatSync(candidate);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new ActionInputError('output must be a regular file, not a link');
    }
  } catch (error) {
    if (error instanceof ActionInputError) throw error;
    if (error?.code !== 'ENOENT') throw error;
  }

  return resolve(realParent, basename(candidate));
}

function validateAuditPath(value) {
  if (!value || value.length > 4096 || /[\0\r\n]/u.test(value)) {
    throw new ActionInputError('path must be a non-empty single-line path of at most 4096 characters');
  }
  return value;
}

function openOutput(path) {
  let flags = constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY;
  if (typeof constants.O_NOFOLLOW === 'number') flags |= constants.O_NOFOLLOW;
  return openSync(path, flags, 0o600);
}

function writeActionOutput(githubOutput, code) {
  if (!githubOutput) throw new Error('GITHUB_OUTPUT is not set');
  appendFileSync(githubOutput, `exit-code=${code}\n`, { encoding: 'utf8' });
}

export async function runAudit(env = process.env) {
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  const format = validateFormat(env.SKILL_SWITCH_FORMAT || 'sarif');
  const version = validateVersion(env.SKILL_SWITCH_VERSION || '');
  const auditPath = validateAuditPath(env.SKILL_SWITCH_PATH || '.');
  const extraArgs = tokenizeExtraArgs(env.SKILL_SWITCH_ARGS || '');
  const outputPath = validateOutputPath(env.SKILL_SWITCH_OUTPUT || 'skill-switch.sarif', workspace);
  const packageSpec = `${PACKAGE_NAME}@${version}`;
  const args = [
    '--yes',
    '--package',
    packageSpec,
    '--',
    'skill-switch',
    'audit',
    auditPath,
    '--format',
    format,
    ...extraArgs,
  ];

  let outputFd;
  let result;
  try {
    outputFd = format === 'github' ? undefined : openOutput(outputPath);
    result = spawnSync('npx', args, {
      cwd: workspace,
      env,
      shell: false,
      stdio: format === 'github' ? 'inherit' : ['ignore', outputFd, 'inherit'],
    });
  } finally {
    if (outputFd !== undefined) closeSync(outputFd);
  }

  if (result.error) throw result.error;
  const code = Number.isInteger(result.status) ? result.status : 1;
  writeActionOutput(env.GITHUB_OUTPUT, code);

  if (format !== 'github' && format !== 'sarif') {
    await pipeline(createReadStream(outputPath), process.stdout, { end: false });
  }
  console.log(`skill-switch audit exit code: ${code}`);
  return code;
}

function workflowCommandValue(value) {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

async function main() {
  try {
    await runAudit();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error::${workflowCommandValue(message)}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
