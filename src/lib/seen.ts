// Proposal ids this device has already announced (or created itself), so each is announced once.

const SEEN_KEY = 'eos.proposals.seen.v1';

function load(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

const seen = load();

export const isProposalSeen = (id: string) => seen.has(id);

export function markProposalSeen(id: string) {
  if (seen.has(id)) return;
  seen.add(id);
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-200)));
  } catch {
    /* ignore */
  }
}
