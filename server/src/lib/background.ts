/**
 * Work that continues after the response is sent (e.g. reading an uploaded document).
 * On Vercel the function would otherwise be frozen once it has replied, so the work is
 * registered with the request context's waitUntil — the same hook @vercel/functions uses.
 * Elsewhere the promise simply runs on.
 */
export function inBackground(work: Promise<unknown>): void {
  const ctx = (globalThis as Record<symbol, { get?: () => { waitUntil?: (p: Promise<unknown>) => void } | undefined } | undefined>)[Symbol.for('@vercel/request-context')]?.get?.();
  const settled = work.catch(() => undefined);
  ctx?.waitUntil?.(settled);
}
