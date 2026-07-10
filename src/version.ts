import packageJson from '../package.json' with { type: 'json' };

/** Single version source for source, npm, and bundled SEA execution. */
export const SKILL_SWITCH_VERSION = packageJson.version;
