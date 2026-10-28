import { describe, expect, it } from 'vitest';
import { appendSpoken, pickMode } from '../src/lib/speech';

// v2.2 phase 2: speech input picks the right engine; typing always stays possible.
describe('speech-to-text for Explain', () => {
  it('uses the native recogniser in the Android app, the browser engine on the PC, else typing', () => {
    expect(pickMode({ native: true, nativeAvailable: true, webCtor: false })).toBe('native');
    expect(pickMode({ native: true, nativeAvailable: false, webCtor: true })).toBe('none'); // the Android WebView's own API does not work
    expect(pickMode({ native: false, nativeAvailable: false, webCtor: true })).toBe('web');
    expect(pickMode({ native: false, nativeAvailable: false, webCtor: false })).toBe('none');
  });

  it('adds what you said after what you typed', () => {
    expect(appendSpoken('An eigenvector', ' keeps its direction ')).toBe('An eigenvector keeps its direction');
    expect(appendSpoken('', 'spoken only')).toBe('spoken only');
    expect(appendSpoken('typed only', '')).toBe('typed only');
  });
});
