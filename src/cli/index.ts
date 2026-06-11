import { buildProgram } from './program.ts';

await buildProgram().parseAsync(process.argv);
