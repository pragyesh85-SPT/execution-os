// node:sqlite still prints an "experimental" warning on load. It is stable for our use;
// hide just that one line so the hub's console stays readable.
const emit = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning?.message;
  if (text && text.includes('SQLite')) return;
  (emit as (w: string | Error, ...r: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

export {};
