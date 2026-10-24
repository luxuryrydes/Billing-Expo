/** Thin fetch wrapper. The session lives in an httpOnly cookie set by the API. */
export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(`/api${url}`, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : undefined,
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok) {
    const j = type.includes('json') ? await res.json().catch(() => ({})) : {};
    throw new ApiError(res.status, j.error ?? `${res.status} ${res.statusText}`, j.details);
  }
  if (type.includes('json')) return res.json();
  return (await res.blob()) as unknown as T;
}

export const api = {
  get: <T = any>(url: string) => request<T>('GET', url),
  post: <T = any>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  put: <T = any>(url: string, body: unknown) => request<T>('PUT', url, body),
  patch: <T = any>(url: string, body: unknown) => request<T>('PATCH', url, body),
  blob: (method: string, url: string, body?: unknown) => request<Blob>(method, url, body),
};

export function qs(params: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const fileUrl = (id: string, inline = false) => `/api/files/${id}/download${inline ? '?inline=1' : ''}`;

export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const d = Array.isArray(e.details) ? e.details.map((x) => (typeof x === 'string' ? x : x.message ?? x.error ?? JSON.stringify(x))).join('\n') : '';
    return d && !e.message.includes(d) ? `${e.message}\n${d}` : e.message;
  }
  return (e as Error)?.message ?? String(e);
}
