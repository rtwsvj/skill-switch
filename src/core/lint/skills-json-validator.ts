// skills.json structural validator — hand-written, no json-schema library.
// Validates the shape of a parsed SkillsDeclarationFile against the types
// defined in src/core/sync.ts.  Returns findings in the same LintIssue format
// used elsewhere in the lint pipeline.
//
// Error severity is used for missing/wrong-type required fields and for the
// version mismatch; warning severity is used for unrecognised agent identifiers
// (forward-compat: a new agent added upstream shouldn't block the user).

import type { LintIssue } from './portability.ts';

// Keep in sync with src/vendor/vercel-skills/types.ts  AgentType
// (duplicated here so this module is a pure runtime check with no extra imports)
const KNOWN_AGENTS = new Set<string>([
  'aider-desk', 'amp', 'antigravity', 'antigravity-cli', 'astrbot',
  'autohand-code', 'augment', 'bob', 'claude-code', 'openclaw', 'cline',
  'codearts-agent', 'codebuddy', 'codemaker', 'codestudio', 'codex',
  'command-code', 'continue', 'cortex', 'crush', 'cursor', 'deepagents',
  'devin', 'dexto', 'droid', 'firebender', 'forgecode', 'gemini-cli',
  'github-copilot', 'goose', 'hermes-agent', 'inference-sh', 'iflow-cli',
  'jazz', 'junie', 'kilo', 'kimi-code-cli', 'kiro-cli', 'kode', 'lingma',
  'loaf', 'mcpjam', 'mistral-vibe', 'moxby', 'mux', 'neovate', 'opencode',
  'openhands', 'ona', 'pi', 'qoder', 'qoder-cn', 'qwen-code', 'replit',
  'reasonix', 'roo', 'rovodev', 'tabnine-cli', 'terramind', 'tinycloud',
  'trae', 'trae-cn', 'warp', 'windsurf', 'zed', 'zencoder', 'zenflow',
  'pochi', 'promptscript', 'adal', 'universal',
]);

const VALID_MODES = new Set<string>(['symlink', 'copy']);

/** A structural finding from validateSkillsJson, with an optional path label */
export interface SkillsJsonFinding extends LintIssue {
  /** dot-path into the skills.json structure, e.g. "skills[0].agents[1]" */
  path?: string;
}

function err(rule: string, message: string, path?: string): SkillsJsonFinding {
  return { severity: 'error', rule, message, path };
}

function warn(rule: string, message: string, path?: string): SkillsJsonFinding {
  return { severity: 'warning', rule, message, path };
}

/**
 * Validates the parsed contents of a skills.json file.
 * The `parsed` argument should be the result of JSON.parse — not the raw string.
 * Returns an empty array when the file is structurally valid.
 */
export function validateSkillsJson(parsed: unknown): SkillsJsonFinding[] {
  const findings: SkillsJsonFinding[] = [];

  // Top-level must be an object
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    findings.push(err('skills-json/invalid-root', 'skills.json root must be a JSON object'));
    return findings;
  }

  const root = parsed as Record<string, unknown>;

  // version
  if (!('version' in root)) {
    findings.push(err('skills-json/missing-version', "Missing required field 'version'", 'version'));
  } else if (root.version !== 1) {
    findings.push(
      err(
        'skills-json/bad-version',
        `Field 'version' must be 1, got: ${JSON.stringify(root.version)}`,
        'version',
      ),
    );
  }

  // skills array
  if (!('skills' in root)) {
    findings.push(err('skills-json/missing-skills', "Missing required field 'skills'", 'skills'));
    return findings;
  }

  if (!Array.isArray(root.skills)) {
    findings.push(
      err('skills-json/skills-not-array', "Field 'skills' must be an array", 'skills'),
    );
    return findings;
  }

  const skills = root.skills as unknown[];
  for (let i = 0; i < skills.length; i++) {
    const base = `skills[${i}]`;
    const skill = skills[i];

    if (typeof skill !== 'object' || skill === null || Array.isArray(skill)) {
      findings.push(err('skills-json/skill-not-object', `${base} must be an object`, base));
      continue;
    }

    const s = skill as Record<string, unknown>;

    // name
    if (!('name' in s)) {
      findings.push(err('skills-json/skill-missing-name', `${base}: missing required field 'name'`, `${base}.name`));
    } else if (typeof s.name !== 'string' || s.name.trim() === '') {
      findings.push(
        err('skills-json/skill-bad-name', `${base}.name must be a non-empty string`, `${base}.name`),
      );
    }

    // source
    if (!('source' in s)) {
      findings.push(err('skills-json/skill-missing-source', `${base}: missing required field 'source'`, `${base}.source`));
    } else if (typeof s.source !== 'string' || s.source.trim() === '') {
      findings.push(
        err('skills-json/skill-bad-source', `${base}.source must be a non-empty string`, `${base}.source`),
      );
    }

    // agents
    if (!('agents' in s)) {
      findings.push(err('skills-json/skill-missing-agents', `${base}: missing required field 'agents'`, `${base}.agents`));
    } else if (!Array.isArray(s.agents)) {
      findings.push(err('skills-json/skill-agents-not-array', `${base}.agents must be an array`, `${base}.agents`));
    } else {
      const agents = s.agents as unknown[];
      if (agents.length === 0) {
        findings.push(
          err('skills-json/skill-agents-empty', `${base}.agents must not be empty`, `${base}.agents`),
        );
      }
      for (let j = 0; j < agents.length; j++) {
        const ap = `${base}.agents[${j}]`;
        const agent = agents[j];
        if (typeof agent !== 'string') {
          findings.push(err('skills-json/skill-agent-not-string', `${ap} must be a string`, ap));
        } else if (!KNOWN_AGENTS.has(agent)) {
          findings.push(
            warn('skills-json/skill-unknown-agent', `${ap}: unknown agent '${agent}'`, ap),
          );
        }
      }
    }

    // enabled
    if (!('enabled' in s)) {
      findings.push(err('skills-json/skill-missing-enabled', `${base}: missing required field 'enabled'`, `${base}.enabled`));
    } else if (typeof s.enabled !== 'boolean') {
      findings.push(
        err('skills-json/skill-bad-enabled', `${base}.enabled must be a boolean`, `${base}.enabled`),
      );
    }

    // mode
    if (!('mode' in s)) {
      findings.push(err('skills-json/skill-missing-mode', `${base}: missing required field 'mode'`, `${base}.mode`));
    } else if (!VALID_MODES.has(s.mode as string)) {
      findings.push(
        err(
          'skills-json/skill-bad-mode',
          `${base}.mode must be 'symlink' or 'copy', got: ${JSON.stringify(s.mode)}`,
          `${base}.mode`,
        ),
      );
    }

    // agentSources (optional)
    if ('agentSources' in s && s.agentSources !== undefined) {
      if (typeof s.agentSources !== 'object' || s.agentSources === null || Array.isArray(s.agentSources)) {
        findings.push(
          err('skills-json/skill-bad-agentSources', `${base}.agentSources must be an object`, `${base}.agentSources`),
        );
      } else {
        const asSrc = s.agentSources as Record<string, unknown>;
        for (const [agent, override] of Object.entries(asSrc)) {
          const ap = `${base}.agentSources.${agent}`;
          if (!KNOWN_AGENTS.has(agent)) {
            findings.push(warn('skills-json/skill-unknown-agent', `${ap}: unknown agent '${agent}'`, ap));
          }
          if (typeof override !== 'object' || override === null || Array.isArray(override)) {
            findings.push(err('skills-json/skill-agentSource-not-object', `${ap} must be an object`, ap));
            continue;
          }
          const ov = override as Record<string, unknown>;
          if (!('source' in ov) || typeof ov.source !== 'string' || ov.source.trim() === '') {
            findings.push(err('skills-json/skill-agentSource-bad-source', `${ap}.source must be a non-empty string`, `${ap}.source`));
          }
          if (!('mode' in ov) || !VALID_MODES.has(ov.mode as string)) {
            findings.push(
              err('skills-json/skill-agentSource-bad-mode', `${ap}.mode must be 'symlink' or 'copy'`, `${ap}.mode`),
            );
          }
        }
      }
    }
  }

  return findings;
}
