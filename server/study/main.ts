import { resolve } from 'node:path';
import { runStudyCli } from './cli';

// Entry point of build/study.cjs (`npm run study -- <command>`, or `study` inside the vault).
void runStudyCli(process.argv.slice(2), { engine: process.argv[1] ? resolve(process.argv[1]) : undefined }).then((code) => {
  process.exitCode = code;
});
