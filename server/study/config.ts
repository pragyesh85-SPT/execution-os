import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Provider } from '../../src/lib/ai';
import { defaultVaultPath } from './vault';

// Study OS settings that belong to this PC only: study.json next to the Execution OS database
// (%APPDATA%\execution-os\study.json). Never synced, never inside the vault (so never in its git
// history), never in the repo. It holds the vault path and the Quick Tutor provider, including its key.

export interface TutorConfig {
  provider: Provider | 'ollama' | 'none';
  model: string;
  apiKey?: string;
  baseUrl?: string; // OpenAI-compatible endpoints and Ollama (default http://localhost:11434/v1)
  monthlyCapUsd: number; // the tutor stops (and Claude grades tonight) once the estimate reaches it
  usdPerMTokIn: number; // price used for the spend estimate
  usdPerMTokOut: number;
}

export interface StudyConfig {
  vault?: string;
  tutor?: TutorConfig;
  testMinutes?: number; // overrides assessment.yaml
  driftMinutes?: number; // no activity this long during a live session marks drift (default 10)
}

export const NO_TUTOR: TutorConfig = { provider: 'none', model: '', monthlyCapUsd: 5, usdPerMTokIn: 0, usdPerMTokOut: 0 };

export class StudyConfigFile {
  readonly file: string;
  constructor(eosDbFile: string) {
    this.file = join(dirname(eosDbFile), 'study.json');
  }

  read(): StudyConfig {
    if (!existsSync(this.file)) return {};
    try {
      const c = JSON.parse(readFileSync(this.file, 'utf8')) as StudyConfig;
      return c && typeof c === 'object' ? c : {};
    } catch {
      return {};
    }
  }

  write(patch: Partial<StudyConfig>): StudyConfig {
    const next = { ...this.read(), ...patch };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, this.file);
    return next;
  }

  /** EOS_STUDY_VAULT wins (tests, manual runs), then study.json, then the default folder. */
  vault(): string {
    return process.env.EOS_STUDY_VAULT || this.read().vault || defaultVaultPath();
  }

  tutor(): TutorConfig {
    return { ...NO_TUTOR, ...(this.read().tutor ?? {}) };
  }
}

/** The tutor config without its key — safe to show on any paired device. */
export function publicTutor(t: TutorConfig) {
  const { apiKey, ...rest } = t;
  return { ...rest, hasKey: !!apiKey };
}
