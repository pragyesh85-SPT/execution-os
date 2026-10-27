import { dump, JSON_SCHEMA, load } from 'js-yaml';

// Vault files are YAML (or Markdown with YAML front matter). JSON_SCHEMA: no custom tags, no dates
// turned into Date objects — "2026-11-30" stays a string, exactly as Claude wrote it.

export class VaultFileError extends Error {}

export function parseYaml(text: string, file = 'file'): unknown {
  try {
    return load(text, { schema: JSON_SCHEMA, filename: file }) ?? {};
  } catch (e) {
    throw new VaultFileError(`${file}: ${(e as Error).message.split('\n')[0]}`);
  }
}

export function dumpYaml(value: unknown): string {
  return dump(value, { schema: JSON_SCHEMA, lineWidth: 120, noRefs: true, sortKeys: false });
}

/** Split "---\n<yaml>\n---\n<body>" into its parts. A file without front matter is all body. */
export function frontMatter(text: string, file = 'file'): { meta: Record<string, unknown>; body: string } {
  const t = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(t);
  if (!m) return { meta: {}, body: t };
  const meta = parseYaml(m[1], file);
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new VaultFileError(`${file}: the front matter must be a YAML mapping`);
  return { meta: meta as Record<string, unknown>, body: m[2] };
}

export function withFrontMatter(meta: Record<string, unknown>, body: string): string {
  return `---\n${dumpYaml(meta)}---\n${body.startsWith('\n') ? body.slice(1) : body}`;
}
