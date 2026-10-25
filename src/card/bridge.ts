// A minimal MCP Apps view bridge: JSON-RPC 2.0 over postMessage with the host (Claude).
// It speaks the same messages as the official App class of @modelcontextprotocol/ext-apps 1.7.5
// (protocol 2026-01-26) — ui/initialize, ui/notifications/initialized, ui/notifications/tool-result,
// ui/notifications/host-context-changed, ui/notifications/size-changed and tools/call — without its
// zod validation layer, which alone would make the card larger than the 150 KB budget.

export const PROTOCOL_VERSION = '2026-01-26';

export interface ToolResult {
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

type Json = Record<string, unknown>;

export class Bridge {
  private seq = 0;
  private waiting = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  ontoolresult?: (r: ToolResult) => void;
  onhostcontext?: (ctx: { theme?: 'light' | 'dark' }) => void;

  constructor(private appInfo = { name: 'Execution OS proposal', version: '1.0.0' }) {
    window.addEventListener('message', (e) => {
      if (e.source !== window.parent) return; // only the host frame may talk to the card
      this.receive(e.data as Json);
    });
  }

  private post(msg: Json) {
    window.parent.postMessage({ jsonrpc: '2.0', ...msg }, '*');
  }

  private request(method: string, params: Json, timeoutMs = 30_000): Promise<Json> {
    const id = ++this.seq;
    this.post({ id, method, params });
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.waiting.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
    });
  }

  private notify(method: string, params: Json = {}) {
    this.post({ method, params });
  }

  private receive(m: Json) {
    if (!m || m.jsonrpc !== '2.0') return;
    if (typeof m.id === 'number' && ('result' in m || 'error' in m)) {
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      if (m.error) w.reject(new Error(String((m.error as Json).message ?? 'Host error')));
      else w.resolve((m.result as Json) ?? {});
      return;
    }
    const params = (m.params as Json) ?? {};
    if (m.id !== undefined) {
      // requests from the host (ping, teardown): acknowledge
      this.post({ id: m.id, result: {} });
      return;
    }
    if (m.method === 'ui/notifications/tool-result') this.ontoolresult?.(params as ToolResult);
    if (m.method === 'ui/notifications/host-context-changed') this.onhostcontext?.(params as { theme?: 'light' | 'dark' });
  }

  async connect(): Promise<{ theme?: 'light' | 'dark' } | undefined> {
    const r = await this.request('ui/initialize', { appCapabilities: {}, appInfo: this.appInfo, protocolVersion: PROTOCOL_VERSION });
    this.notify('ui/notifications/initialized');
    this.watchSize();
    return r.hostContext as { theme?: 'light' | 'dark' } | undefined;
  }

  callTool(name: string, args: Json): Promise<ToolResult> {
    return this.request('tools/call', { name, arguments: args }) as Promise<ToolResult>;
  }

  /** Tell the host how tall the card is so it can size the frame. */
  private watchSize() {
    let w = 0;
    let h = 0;
    let queued = false;
    const send = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        const el = document.documentElement;
        const prev = el.style.height;
        el.style.height = 'max-content';
        const height = Math.ceil(el.getBoundingClientRect().height);
        el.style.height = prev;
        const width = Math.ceil(window.innerWidth);
        if (width !== w || height !== h) {
          w = width;
          h = height;
          this.notify('ui/notifications/size-changed', { width, height });
        }
      });
    };
    send();
    const ro = new ResizeObserver(send);
    ro.observe(document.documentElement);
    ro.observe(document.body);
  }
}
