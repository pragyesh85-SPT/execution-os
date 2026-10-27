import { CalendarClock, FolderInput, FolderPlus, KeyRound, Play } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Field } from '../components/ui';
import { studyCall } from '../lib/studyApi';
import { useStore } from '../state/store';

// Study OS setup, on the PC only (the hub refuses these calls from other devices): create the vault,
// ingest a folder of course assets, choose the Quick Tutor provider, and register the headless jobs
// in Windows Task Scheduler. Everything here can also be done with the `study` command.

export interface Setup {
  enabled: boolean;
  vault: string;
  exists: boolean;
  local: boolean;
  engine: boolean;
  tutor: { provider: string; model: string; baseUrl?: string; monthlyCapUsd: number; usdPerMTokIn: number; usdPerMTokOut: number; hasKey: boolean };
}

interface Schedule {
  supported: boolean;
  claude: string | null;
  tasks: { name: string; job: string; when: string; registered: boolean; nextRun: string | null }[];
}

export function useSetup() {
  const [s, set] = useState<Setup | null>(null);
  const load = useCallback(() => void studyCall<Setup>('setup').then(set, () => set(null)), []);
  useEffect(load, [load]);
  return [s, load] as const;
}

/** No vault yet: create it right here (PC), or explain where to do it (phone). */
export function CreateVault({ onDone }: { onDone: () => void }) {
  const toast = useStore((st) => st.toast);
  const [setup] = useSetup();
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setPath((p) => p || setup?.vault || ''), [setup]);
  if (!setup) return <div className="empty">Checking the PC…</div>;
  if (!setup.local)
    return (
      <div className="empty">
        <strong>Create your Study Vault on the PC</strong>
        Open Execution OS on the PC → Study → "Create my Study Vault". This phone shows it as soon as it exists.
      </div>
    );
  const create = async () => {
    setBusy(true);
    try {
      const r = await studyCall<{ root: string; created: string[] }>('setupVault', { path });
      toast(`Study Vault ready at ${r.root}`, 'success');
      onDone();
    } catch (e) {
      toast((e as Error).message, 'warn');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card">
      <h2 className="card-title">Create your Study Vault</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        One private folder on this PC holds everything Study OS knows: your course assets, the concepts, resources, checks, labs, tests and your progress. It never leaves this PC (only a small daily summary syncs to your phone). Pick a folder outside the Execution OS program folder.
      </p>
      <Field label="Vault folder">
        <input className="input mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\StudyOS" />
      </Field>
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={busy || !path.trim()} onClick={() => void create()}>
          <FolderPlus size={15} /> Create my Study Vault
        </button>
      </div>
    </section>
  );
}

/** The setup card at the bottom of the Study tab (PC only). */
export function StudySetup({ subjects, onChanged }: { subjects: { subject: string; title: string }[]; onChanged: () => void }) {
  const toast = useStore((st) => st.toast);
  const [setup, reload] = useSetup();
  const [open, setOpen] = useState(false);
  const [folder, setFolder] = useState('');
  const [subject, setSubject] = useState('');
  const [busy, setBusy] = useState('');
  const [tutor, setTutor] = useState<{ provider: string; model: string; apiKey: string; baseUrl: string; monthlyCapUsd: string; usdPerMTokIn: string; usdPerMTokOut: string } | null>(null);
  const [sched, setSched] = useState<Schedule | null>(null);
  const [out, setOut] = useState('');

  useEffect(() => {
    if (setup && !tutor) setTutor({ provider: setup.tutor.provider, model: setup.tutor.model, apiKey: '', baseUrl: setup.tutor.baseUrl ?? '', monthlyCapUsd: String(setup.tutor.monthlyCapUsd), usdPerMTokIn: String(setup.tutor.usdPerMTokIn), usdPerMTokOut: String(setup.tutor.usdPerMTokOut) });
  }, [setup, tutor]);
  useEffect(() => {
    if (open && setup?.local) void studyCall<Schedule>('schedule').then(setSched, () => {});
  }, [open, setup]);

  if (!setup?.local || !setup.exists) return null;

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    try {
      setOut(await fn());
      onChanged();
    } catch (e) {
      setOut((e as Error).message);
      toast((e as Error).message, 'warn');
    } finally {
      setBusy('');
    }
  };
  const ingest = () =>
    run('ingest', async () => {
      const r = await studyCall<{ added: unknown[]; duplicates: unknown[]; unsorted: string[]; skipped: unknown[]; index: { stubs: number } }>('ingest', { folder, ...(subject ? { subject } : {}) });
      return `${r.added.length} asset(s) added, ${r.duplicates.length} already there, ${r.unsorted.length} without a subject (inbox/unsorted), ${r.skipped.length} skipped; ${r.index.stubs} concept stub(s) created. Next: run the ingest job below (Claude decomposes the assets into concepts).`;
    });
  const saveTutor = () =>
    run('tutor', async () => {
      const t = tutor!;
      const r = await studyCall<Setup['tutor']>('tutorConfig', { provider: t.provider, model: t.model, baseUrl: t.baseUrl, ...(t.apiKey ? { apiKey: t.apiKey } : {}), monthlyCapUsd: Number(t.monthlyCapUsd) || 0, usdPerMTokIn: Number(t.usdPerMTokIn) || 0, usdPerMTokOut: Number(t.usdPerMTokOut) || 0 });
      setTutor({ ...t, apiKey: '' });
      reload();
      return `Quick Tutor: ${r.provider}${r.model ? ` · ${r.model}` : ''} · key ${r.hasKey ? 'saved on this PC' : 'none'} · cap $${r.monthlyCapUsd}/month.`;
    });
  const testTutor = () => run('test', async () => `Provider answered: ${(await studyCall<{ provider: string; reply: string }>('tutorTest')).reply}`);
  const schedule = (action: 'register' | 'remove') =>
    run(action, async () => {
      const r = await studyCall<{ lines: string[]; status: Schedule | null }>('schedule', { action });
      if (r.status) setSched(r.status);
      return r.lines.join('\n');
    });
  const jobNow = (job: string) => run(`job-${job}`, async () => (await studyCall('runJobNow', { job }), `Started the ${job} job in the background. Its log is in the vault's logs/ folder; the result shows on this tab when it finishes.`));

  const P = ['none', 'ollama', 'anthropic', 'openai', 'gemini', 'compatible'];
  return (
    <section className="card">
      <h2 className="card-title">
        Study setup (this PC)
        <button className="btn ghost sm" onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Show'}
        </button>
      </h2>
      {!open ? (
        <p className="faint" style={{ margin: 0 }}>
          Vault {setup.vault} · Quick Tutor {setup.tutor.provider === 'none' ? 'built-in matcher' : setup.tutor.provider} · assets, tutor and scheduled jobs
        </p>
      ) : (
        <div className="stack lg">
          <div>
            <strong>
              <FolderInput size={14} /> Add course assets
            </strong>
            <p className="faint" style={{ margin: '2px 0 8px' }}>
              The folder with the IITJ slides, transcripts, quizzes, assignments. Files are copied (never moved or changed) into the vault; the same file twice is skipped.
            </p>
            <div className="row wrap">
              <input className="input mono grow" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="D:\IITJ\Semester 1" />
              <select className="select" value={subject} onChange={(e) => setSubject(e.target.value)}>
                <option value="">Subject from folder names</option>
                {subjects.map((s) => (
                  <option key={s.subject} value={s.subject}>
                    {s.title}
                  </option>
                ))}
              </select>
              <button className="btn primary sm" disabled={!folder.trim() || !!busy} onClick={() => void ingest()}>
                {busy === 'ingest' ? 'Copying…' : 'Ingest'}
              </button>
            </div>
          </div>

          {tutor && (
            <div>
              <strong>
                <KeyRound size={14} /> Quick Tutor provider
              </strong>
              <p className="faint" style={{ margin: '2px 0 8px' }}>
                The small fast model that checks your explanations instantly (only against Claude's packs). None set = the built-in matcher, and Claude re-grades every check at night. The key stays on this PC.
              </p>
              <div className="form-grid">
                <Field label="Provider">
                  <select className="select" value={tutor.provider} onChange={(e) => setTutor({ ...tutor, provider: e.target.value })}>
                    {P.map((p) => (
                      <option key={p} value={p}>
                        {p === 'none' ? 'None (built-in matcher)' : p === 'ollama' ? 'Ollama on this PC (free)' : p === 'compatible' ? 'OpenAI-compatible' : p}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Model">
                  <input className="input mono" value={tutor.model} onChange={(e) => setTutor({ ...tutor, model: e.target.value })} placeholder={tutor.provider === 'ollama' ? 'llama3.2' : tutor.provider === 'anthropic' ? 'claude-haiku-4-5' : 'model name'} />
                </Field>
                {(tutor.provider === 'anthropic' || tutor.provider === 'openai' || tutor.provider === 'gemini' || tutor.provider === 'compatible') && (
                  <Field label="API key" hint={setup.tutor.hasKey ? 'A key is saved. Leave empty to keep it.' : undefined}>
                    <input className="input mono" type="password" value={tutor.apiKey} onChange={(e) => setTutor({ ...tutor, apiKey: e.target.value })} />
                  </Field>
                )}
                {(tutor.provider === 'compatible' || tutor.provider === 'ollama') && (
                  <Field label="Base URL">
                    <input className="input mono" value={tutor.baseUrl} onChange={(e) => setTutor({ ...tutor, baseUrl: e.target.value })} placeholder="http://localhost:11434/v1" />
                  </Field>
                )}
                <Field label="Monthly cap (USD)">
                  <input className="input mono" value={tutor.monthlyCapUsd} onChange={(e) => setTutor({ ...tutor, monthlyCapUsd: e.target.value })} />
                </Field>
                <Field label="Price per million tokens in / out (USD)">
                  <div className="row">
                    <input className="input mono" value={tutor.usdPerMTokIn} onChange={(e) => setTutor({ ...tutor, usdPerMTokIn: e.target.value })} />
                    <input className="input mono" value={tutor.usdPerMTokOut} onChange={(e) => setTutor({ ...tutor, usdPerMTokOut: e.target.value })} />
                  </div>
                </Field>
              </div>
              <div className="btn-row" style={{ marginTop: 8 }}>
                <button className="btn primary sm" disabled={!!busy} onClick={() => void saveTutor()}>
                  Save
                </button>
                <button className="btn sm" disabled={!!busy || setup.tutor.provider === 'none'} onClick={() => void testTutor()}>
                  Test connection
                </button>
              </div>
            </div>
          )}

          <div>
            <strong>
              <CalendarClock size={14} /> Scheduled Claude jobs
            </strong>
            <p className="faint" style={{ margin: '2px 0 8px' }}>
              Claude Code does the heavy work at night on your subscription: ingest → resources → checks → labs, the nightly review, the 3-day test and its grading, the Sunday review. Needs Claude Code installed and signed in; tasks run while you are signed in to Windows.
            </p>
            {sched ? (
              <>
                <p style={{ margin: '0 0 6px', fontSize: 14 }}>Claude Code: {sched.claude ?? <span style={{ color: 'var(--warn)' }}>not found — install it and sign in first</span>}</p>
                {sched.tasks.map((t) => (
                  <div key={t.name} className="row between wrap" style={{ fontSize: 14 }}>
                    <span>
                      {t.registered ? '✓' : '·'} <strong>{t.name}</strong> <span className="faint">{t.when}{t.nextRun ? ` · next ${t.nextRun}` : ''}</span>
                    </span>
                    <button className="btn ghost sm" disabled={!!busy} onClick={() => void jobNow(t.job)}>
                      <Play size={13} /> Run now
                    </button>
                  </div>
                ))}
                <div className="btn-row" style={{ marginTop: 8 }}>
                  <button className="btn primary sm" disabled={!!busy || !sched.supported} onClick={() => void schedule('register')}>
                    Register all
                  </button>
                  <button className="btn ghost sm" disabled={!!busy || !sched.supported} onClick={() => void schedule('remove')}>
                    Remove all
                  </button>
                </div>
              </>
            ) : (
              <p className="faint">Checking Task Scheduler…</p>
            )}
          </div>
          {out && <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 12 }}>{out}</pre>}
        </div>
      )}
    </section>
  );
}
