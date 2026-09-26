/** Errors carry an HTTP status and a {"detail": ...} body; the pages show `detail`. */
export class HttpError extends Error {
  constructor(public status: number, public detail: string) {
    super(detail);
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export const unprocessable = (detail: string) => new HttpError(422, detail);

/** Optional integer query param; 422 if present but not an integer in [min, max]. */
export function intParam(url: URL, name: string, opts: { def?: number; min?: number; max?: number } = {}): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return opts.def;
  if (!/^-?\d+$/.test(raw)) throw unprocessable(`${name} must be an integer`);
  const n = Number(raw);
  if (opts.min !== undefined && n < opts.min) throw unprocessable(`${name} must be >= ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) throw unprocessable(`${name} must be <= ${opts.max}`);
  return n;
}

/** Optional YYYY-MM-DD query param. */
export function dateParam(url: URL, name: string): string | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw unprocessable(`${name} must be a date (YYYY-MM-DD)`);
  }
  return raw;
}
