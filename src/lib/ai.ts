
// AI is optional. With no key, every AI feature has a manual path:
//   - "Smart fill" (built-in, deterministic) or typing missions yourself
//   - "Copy prompt" -> paste into any chat AI -> paste the reply back
// With a key, the same prompt is sent directly from this device. The key is stored only on
// this device (never synced to the hub or other devices).

export type Provider = 'anthropic' | 'openai' | 'gemini' | 'compatible';

export interface AiConfig {
  provider: Provider;
  apiKey: string;
  model: string;
  baseUrl: string;
}

export const PROVIDERS: { id: Provider; label: string; defaultModel: string; models: string[]; hint: string }[] = [
  {
    id: 'anthropic',
    label: 'Claude (Anthropic)',
    defaultModel: 'claude-opus-5-5',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-fable-5-1'],
    hint: 'Key starts with sk-ant-. Create one at console.anthropic.com.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-4.1',
    models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o'],
    hint: 'Key starts with sk-. Create one at platform.openai.com.',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    defaultModel: 'gemini-2.5-flash',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    hint: 'Create a key at aistudio.google.com.',
  },
  {
    id: 'compatible',
    label: 'OpenAI-compatible (OpenRouter, Groq, Ollama…)',
    defaultModel: '',
    models: [],
    hint: 'Base URL like https://openrouter.ai/api/v1 or http://localhost:11434/v1',
  },
];

// Models that accept output_config.effort, and the ones that accept server-side refusal fallbacks.
const EFFORT_MODELS = /^claude-(opus-5|opus-4-[5-8]|sonnet-5|sonnet-4-6|fable-5|mythos-5)/;
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

export class AiError extends Error {}

export async function aiComplete(cfg: AiConfig, system: string, user: string, opts: { json?: boolean; maxTokens?: number } = {}): Promise<string> {
  if (!cfg.apiKey && cfg.provider !== 'compatible') throw new AiError('Add an API key in Settings → AI first.');
  const maxTokens = opts.maxTokens ?? 8000;
  switch (cfg.provider) {
    case 'anthropic':
      return anthropic(cfg, system, user, maxTokens);
    case 'openai':
      return openaiLike('https://api.openai.com/v1', cfg, system, user, maxTokens, opts.json);
    case 'compatible':
      if (!cfg.baseUrl) throw new AiError('Set the base URL for your OpenAI-compatible provider.');
      return openaiLike(cfg.baseUrl.replace(/\/$/, ''), cfg, system, user, maxTokens, opts.json);
    case 'gemini':
      return gemini(cfg, system, user, maxTokens, opts.json);
  }
}

async function anthropic(cfg: AiConfig, system: string, user: string, maxTokens: number): Promise<string> {
  // Loaded on demand so the SDK does not weigh down app start-up.
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: cfg.apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 });
  const model = cfg.model || 'claude-opus-5-5';
  const useFallback = FALLBACK_MODELS.has(model);
  try {
    const response = await client.beta.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
      ...(EFFORT_MODELS.test(model) ? { output_config: { effort: 'medium' as const } } : {}),
      ...(useFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    });
    if (response.stop_reason === 'refusal') {
      throw new AiError('The model declined this request. Try rephrasing your tasks or use the manual planner.');
    }
    const text = response.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim();
    if (!text) throw new AiError('The model returned an empty reply.');
    if (response.stop_reason === 'max_tokens') throw new AiError('The reply was cut off (max tokens). Try fewer tasks.');
    return text;
  } catch (err) {
    if (err instanceof AiError) throw err;
    if (err instanceof Anthropic.AuthenticationError) throw new AiError('Anthropic rejected the API key (401). Check it in Settings → AI.');
    if (err instanceof Anthropic.NotFoundError) throw new AiError(`Model "${model}" was not found for this key.`);
    if (err instanceof Anthropic.RateLimitError) throw new AiError('Rate limited by Anthropic. Wait a minute and try again.');
    if (err instanceof Anthropic.APIConnectionError) throw new AiError('Could not reach Anthropic. Check the internet connection.');
    if (err instanceof Anthropic.APIError) throw new AiError(`Anthropic error ${err.status ?? ''}: ${err.message}`);
    throw new AiError((err as Error).message);
  }
}

async function openaiLike(base: string, cfg: AiConfig, system: string, user: string, maxTokens: number, json?: boolean): Promise<string> {
  const res = await safeFetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
  if (!res.ok) throw new AiError(`Provider error ${res.status}: ${data.error?.message ?? res.statusText}`);
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new AiError('The model returned an empty reply.');
  return text;
}

async function gemini(cfg: AiConfig, system: string, user: string, maxTokens: number, json?: boolean): Promise<string> {
  const model = cfg.model || 'gemini-2.5-flash';
  const res = await safeFetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: maxTokens, ...(json ? { responseMimeType: 'application/json' } : {}) },
    }),
  });
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    error?: { message?: string };
  };
  if (!res.ok) throw new AiError(`Gemini error ${res.status}: ${data.error?.message ?? res.statusText}`);
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim();
  if (!text) throw new AiError('Gemini returned an empty reply.');
  return text;
}

async function safeFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new AiError('Could not reach the AI provider. Check the internet connection (or the base URL).');
  }
}

export async function testAi(cfg: AiConfig): Promise<string> {
  const reply = await aiComplete(cfg, 'You are a connectivity check.', 'Reply with exactly: Execution OS connected', { maxTokens: 2000 });
  return reply.slice(0, 120);
}
