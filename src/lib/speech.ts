import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

// Speech-to-text for "Explain it in your own words". Android app: the native StudySpeech plugin (the
// WebView has no speech API). Desktop / browser: the Web Speech API where the browser has it (Chrome,
// Edge). Anywhere else the Speak button is hidden and typing is the way. The words are never sent
// anywhere except as the explanation you submit.

interface StudySpeechPlugin {
  available(): Promise<{ available: boolean }>;
  listen(opts: { language?: string }): Promise<{ text: string }>;
  stop(): Promise<void>;
  addListener(event: 'partial', fn: (e: { text: string }) => void): Promise<PluginListenerHandle>;
}

const Native = registerPlugin<StudySpeechPlugin>('StudySpeech');

type WebRec = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

export type SpeechMode = 'native' | 'web' | 'none';

/** Which speech engine this device can use (pure, for tests: pass the environment in). */
export function pickMode(env: { native: boolean; nativeAvailable: boolean; webCtor: boolean }): SpeechMode {
  if (env.native) return env.nativeAvailable ? 'native' : 'none';
  return env.webCtor ? 'web' : 'none';
}

const webCtor = (): (new () => WebRec) | undefined => {
  const w = globalThis as unknown as { SpeechRecognition?: new () => WebRec; webkitSpeechRecognition?: new () => WebRec };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
};

export async function speechMode(): Promise<SpeechMode> {
  const native = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  let nativeAvailable = false;
  if (native) {
    try {
      nativeAvailable = (await Native.available()).available;
    } catch {
      nativeAvailable = false; // an older app without the plugin
    }
  }
  return pickMode({ native, nativeAvailable, webCtor: !!webCtor() });
}

/** Join what was already typed with what was just said. */
export const appendSpoken = (typed: string, spoken: string) => [typed.trim(), spoken.trim()].filter(Boolean).join(' ');

export interface Listening {
  done: Promise<string>; // the final text ('' when nothing was heard)
  stop: () => void;
}

/** Start listening. onPartial gets the words heard so far (live captions while you speak). */
export function listen(mode: SpeechMode, onPartial: (text: string) => void, language = 'en-IN'): Listening {
  if (mode === 'native') {
    let handle: PluginListenerHandle | undefined;
    void Native.addListener('partial', (e) => onPartial(e.text)).then((h) => (handle = h));
    const done = Native.listen({ language })
      .then((r) => r.text)
      .finally(() => void handle?.remove());
    return { done, stop: () => void Native.stop() };
  }
  if (mode === 'web') {
    const Ctor = webCtor()!;
    const r = new Ctor();
    r.lang = language;
    r.continuous = true;
    r.interimResults = true;
    let finalText = '';
    const done = new Promise<string>((resolve, reject) => {
      r.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) finalText = appendSpoken(finalText, t);
          else interim += t;
        }
        onPartial(appendSpoken(finalText, interim));
      };
      r.onerror = (e) => (e.error === 'no-speech' || e.error === 'aborted' ? resolve(finalText) : reject(new Error(`Speech recognition: ${e.error}. You can type instead.`)));
      r.onend = () => resolve(finalText);
    });
    r.start();
    return { done, stop: () => r.stop() };
  }
  return { done: Promise.reject(new Error('Speech input is not available here — type your explanation.')), stop: () => {} };
}
