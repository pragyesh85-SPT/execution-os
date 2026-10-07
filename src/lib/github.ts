// Automatic proof-of-work for development blocks: counts your public GitHub activity
// (commits pushed, PRs opened/merged) inside the block's time window.

interface GhEvent {
  type: string;
  created_at: string;
  repo: { name: string };
  payload: {
    size?: number;
    commits?: unknown[];
    action?: string;
    number?: number;
    pull_request?: { number?: number; merged?: boolean };
  };
}

export async function githubProof(user: string, token: string | undefined, startMs: number, endMs: number): Promise<string[]> {
  if (!user) return [];
  const res = await fetch(`https://api.github.com/users/${encodeURIComponent(user)}/events?per_page=100`, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  const events = (await res.json()) as GhEvent[];
  const inWindow = events.filter((e) => {
    const t = Date.parse(e.created_at);
    return t >= startMs && t <= endMs;
  });
  const commitsByRepo = new Map<string, number>();
  const out: string[] = [];
  for (const e of inWindow) {
    if (e.type === 'PushEvent') {
      const n = e.payload.size ?? e.payload.commits?.length ?? 1;
      const repo = e.repo.name.split('/')[1] ?? e.repo.name;
      commitsByRepo.set(repo, (commitsByRepo.get(repo) ?? 0) + n);
    } else if (e.type === 'PullRequestEvent') {
      const num = e.payload.number ?? e.payload.pull_request?.number;
      if (e.payload.action === 'opened') out.push(`PR #${num} opened`);
      if (e.payload.action === 'closed' && e.payload.pull_request?.merged) out.push(`PR #${num} merged`);
    }
  }
  for (const [repo, n] of commitsByRepo) out.unshift(`${n} commit${n > 1 ? 's' : ''} to ${repo}`);
  return out;
}
