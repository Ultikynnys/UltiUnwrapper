/**
 * Separator-agnostic path helpers for the CLI core.
 *
 * The same helpers run in Node and in the Tauri webview, where `node:path` is
 * unavailable. Both `/` and `\` are treated as separators and results use `/`,
 * which every file API on every platform accepts.
 */

export function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, '/');
}

export function dirname(path: string): string {
  const s = normalizeSeparators(path);
  const i = s.lastIndexOf('/');
  if (i < 0) return '.';
  if (i === 0) return '/';
  return s.slice(0, i);
}

export function basename(path: string, ext?: string): string {
  const s = normalizeSeparators(path);
  let base = s.slice(s.lastIndexOf('/') + 1);
  if (ext && base.endsWith(ext)) base = base.slice(0, -ext.length);
  return base;
}

export function extname(path: string): string {
  const base = basename(path);
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i) : '';
}

export function join(...parts: string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .map(normalizeSeparators)
    .join('/')
    .replace(/\/{2,}/g, '/');
}

export function isAbsolute(path: string): boolean {
  const normalized = normalizeSeparators(path);
  return normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized);
}
