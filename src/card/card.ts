import { Bridge, type ToolResult } from './bridge';

// The proposal card shown inside Claude (MCP Apps). It receives the result of propose_rescue /
// propose_day_plan / propose_week_plan / import_events, draws the before/after of each day with pins
// highlighted, and applies or rejects through the same connector tools the AI uses.
// One bundled file, no network calls of its own; the plain-text result stays as the fallback.

interface CardBlock {
  t: string; // title
  c: string; // category
  s: number; // offset minutes in the logical day
  e: number;
  p?: 1; // pinned
  f?: 1; // fixed (anchor or pin)
}

interface CardDay {
  date: string;
  label: string;
  before: CardBlock[];
  after: CardBlock[];
  changes: string[];
}

interface CardProposal {
  id: string;
  title: string;
  headline?: string;
  scopeAllowed: ('today' | 'week')[];
  dayStart: number; // clock minute the logical day starts
  days: CardDay[];
  warnings?: string[];
}

const COLORS: Record<string, string> = {
  sleep: '#4c5a86',
  devotion: '#c98a0b',
  iit: '#1f6fb2',
  founder: '#2e7d4f',
  meal: '#b4563a',
  care: '#2c8c88',
  rest: '#8a857b',
  buffer: '#a39e92',
  entertainment: '#b0457a',
};

const root = document.getElementById('root')!;
const app = new Bridge();

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);
const clock = (off: number, ds: number) => {
  const c = (((ds + off) % 1440) + 1440) % 1440;
  return `${String(Math.floor(c / 60)).padStart(2, '0')}:${String(c % 60).padStart(2, '0')}`;
};

function bar(blocks: CardBlock[], ds: number) {
  return `<div class="bar">${blocks
    .filter((b) => b.e > b.s)
    .map(
      (b) =>
        `<i class="${b.f ? 'fixed' : ''}${b.p ? ' pin' : ''}" title="${esc(`${b.t} ${clock(b.s, ds)}–${clock(b.e, ds)}${b.p ? ' (pinned)' : b.f ? ' (fixed)' : ''}`)}" style="left:${(b.s / 1440) * 100}%;width:${((b.e - b.s) / 1440) * 100}%;${b.f ? '' : `background:${COLORS[b.c] ?? '#888'}`}"></i>`,
    )
    .join('')}</div>`;
}

function render(list: CardProposal[], note = '') {
  if (!list.length) {
    root.innerHTML = `<p class="muted">No proposal to show.</p>`;
    return;
  }
  root.innerHTML = list
    .map(
      (p) => `
    <section class="card" data-id="${esc(p.id)}">
      <h2>${esc(p.title)}</h2>
      ${p.headline ? `<p class="muted">${esc(p.headline)}</p>` : ''}
      ${p.days
        .map(
          (d) => `
        <div class="day">
          <div class="label">${esc(d.label)}</div>
          <div class="row"><span class="k">Now</span>${bar(d.before, p.dayStart)}</div>
          <div class="row"><span class="k">After</span>${bar(d.after, p.dayStart)}</div>
          <ul>${d.changes.slice(0, 8).map((c) => `<li>${esc(c)}</li>`).join('')}${d.changes.length > 8 ? `<li class="muted">…and ${d.changes.length - 8} more</li>` : ''}</ul>
        </div>`,
        )
        .join('')}
      ${(p.warnings ?? []).map((w) => `<p class="warn">${esc(w)}</p>`).join('')}
      <div class="btns">
        <button data-act="reject">Reject</button>
        ${p.scopeAllowed.includes('week') && p.days.length > 1 ? '<button data-act="week">Apply for the week</button>' : ''}
        ${p.scopeAllowed.includes('today') ? `<button class="primary" data-act="today">Apply${p.days.length > 1 ? ' for today' : ''}</button>` : '<button class="primary" data-act="week">Apply</button>'}
      </div>
      <p class="status" aria-live="polite"></p>
    </section>`,
    )
    .join('') + (note ? `<p class="muted">${esc(note)}</p>` : '');

  root.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const sec = btn.closest<HTMLElement>('section')!;
      const id = sec.dataset.id!;
      const act = btn.dataset.act!;
      const status = sec.querySelector<HTMLElement>('.status')!;
      sec.querySelectorAll('button').forEach((b) => (b.disabled = true));
      status.textContent = 'Working…';
      try {
        const r =
          act === 'reject'
            ? await app.callTool('reject_proposal', { proposalId: id })
            : await app.callTool('apply_proposal', { proposalId: id, scope: act });
        const text = (r.content?.find((c) => c.type === 'text') as { text?: string } | undefined)?.text ?? '';
        status.textContent = (r.isError ? '⚠ ' : '✓ ') + text.split('\n')[0];
        status.className = `status ${r.isError ? 'bad' : 'ok'}`;
        if (!r.isError && act !== 'reject') {
          // other alternatives of the same rescue are superseded now
          root.querySelectorAll<HTMLElement>('section').forEach((s) => {
            if (s !== sec) s.querySelectorAll('button').forEach((b) => (b.disabled = true));
          });
        } else if (r.isError) sec.querySelectorAll('button').forEach((b) => (b.disabled = false));
      } catch (e) {
        status.textContent = `⚠ ${(e as Error).message}`;
        sec.querySelectorAll('button').forEach((b) => (b.disabled = false));
      }
    });
  });
}

app.ontoolresult = (params: ToolResult) => {
  const card = (params.structuredContent as { card?: { proposals: CardProposal[]; note?: string } } | undefined)?.card;
  if (card) render(card.proposals, card.note);
  else root.innerHTML = '<p class="muted">Nothing to review.</p>';
};

app.onhostcontext = (ctx) => {
  if (ctx.theme) document.documentElement.dataset.theme = ctx.theme;
};

root.innerHTML = '<p class="muted">Loading the proposal…</p>';
void app
  .connect()
  .then((ctx) => {
    if (ctx?.theme) document.documentElement.dataset.theme = ctx.theme;
  })
  .catch(() => {
    root.innerHTML = '<p class="muted">This card needs a chat app that supports MCP Apps. The text reply above has the same proposal.</p>';
  });
