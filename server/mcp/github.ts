import type { Doc } from '../../src/core/types';
import { fetchEvents, summarizeEvents, type GithubActivity } from '../../src/lib/github';

// GitHub activity for get_block_context. The hub only knows the synced GitHub username (tokens stay on
// devices), so it uses the public, rate-limited events API and caches each block's answer for 10 minutes.

const TTL = 10 * 60_000;
const cache = new Map<string, { at: number; value: GithubActivity | { error: string } }>();

export async function githubForBlock(doc: Doc, startMs: number, endMs: number, key: string, fetchFn?: typeof fetch): Promise<GithubActivity | { note: string } | { error: string }> {
  const user = doc.settings.githubUser?.trim();
  if (!user) return { note: 'No GitHub username set (Settings → Integrations). If you have a GitHub connector, use it for commit links.' };
  const hit = cache.get(`${user}:${key}`);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  let value: GithubActivity | { error: string };
  try {
    value = summarizeEvents(await fetchEvents(user, undefined, fetchFn), startMs, endMs);
  } catch (e) {
    value = { error: `GitHub could not be checked: ${(e as Error).message}` };
  }
  cache.set(`${user}:${key}`, { at: Date.now(), value });
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return value;
}
