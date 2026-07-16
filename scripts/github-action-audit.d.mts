export class ActionInputError extends Error {}

export function tokenizeExtraArgs(source: string): string[];
export function validateFormat(value: string): string;
export function validateVersion(value: string): string;
export function validateOutputPath(value: string, workspace: string): string;
export function runAudit(env?: NodeJS.ProcessEnv): Promise<number>;
