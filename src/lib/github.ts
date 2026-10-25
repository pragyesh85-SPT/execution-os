// Automatic proof-of-work for development blocks: counts your public GitHub activity
// (commits pushed, PRs opened/merged) inside the block's time window.
// The summary is pure, so the app (with an optional token) and the hub (public events only) share it.

export interface GhEvent {
  type: string;
  created_at: string;
  repo: { name: string };
  payload: {
    size?: number;
    commits?: { message?: string; sha?: string }[];
    action?: string;
    number?: number;
    pull_request?: { number?: number; merged?: boolean; title?: string; html_url?: string };
  };
}

export interface GithubActivity {
  lines: string[]; // "3 commits to execution-os", "PR #218 merged"
  commits: { repo: string; count: number; messages: string[] }[];
  prs: { repo: string; number: number; action: 'opened' | 'merged'; title?: string; url?: string }[];
}

export function summarizeEvents(events: GhEvent[], startMs: number, endMs: number): GithubActivity {
  const inWindow = events.filter((e) => {
    const t = Date.parse(e.created_at);
    return t >= startMs && t <= endMs;
  });
  const byRepo = new Map<string, { count: number; messages: string[] }>();
  const prs: GithubActivity['prs'] = [];
  for (const e of inWindow) {
    const repo = e.repo.name.split('/')[1] ?? e.repo.name;
    if (e.type === 'PushEvent') {
      const n = e.payload.size ?? e.payload.commits?.length ?? 1;
      const cur = byRepo.get(repo) ?? { count: 0, messages: [] };
      cur.count += n;
      for (const c of e.payload.commits ?? []) if (c.message && cur.messages.length < 8) cur.messages.push(c.message.split('\n')[0].slice(0, 120));
      byRepo.set(repo, cur);
    } else if (e.type === 'PullRequestEvent') {
      const num = e.payload.number ?? e.payload.pull_request?.number ?? 0;
      const base = { repo, number: num, title: e.payload.pull_request?.title, url: e.payload.pull_request?.html_url };
      if (e.payload.action === 'opened') prs.push({ ...base, action: 'opened' });
      if (e.payload.action === 'closed' && e.payload.pull_request?.merged) prs.push({ ...base, action: 'merged' });
    }
  }
  const commits = [...byRepo.entries()].map(([repo, v]) => ({ repo, ...v }));
  const lines = [...commits.map((c) => `${c.count} commit${c.count > 1 ? 's' : ''} to ${c.repo}`), ...prs.map((p) => `PR #${p.number} ${p.action}`)];
  return { lines, commits, prs };
}

export async function fetchEvents(user: string, token?: string, fetchFn: typeof fetch = fetch): Promise<GhEvent[]> {
  const res = await fetchFn(`https://api.github.com/users/${encodeURIComponent(user)}/events?per_page=100`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'execution-os', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  return (await res.json()) as GhEvent[];
}

export async function githubProof(user: string, token: string | undefined, startMs: number, endMs: number): Promise<string[]> {
  if (!user) return [];
  return summarizeEvents(await fetchEvents(user, token), startMs, endMs).lines;
}
