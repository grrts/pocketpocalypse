// Some hosts serve the game's files only to the page itself (through the
// host's own request handling), so a worker that fetches them directly gets
// nothing. Workers therefore ask the page to fetch for them.

export interface FetchProxyRequest {
  type: 'fetch';
  fid: number;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface FetchProxyResponse {
  type: 'fetchResult';
  fid: number;
  status: number;
  contentType: string;
  body: ArrayBuffer | null;
  error?: string;
}

let nextFid = 1;
const waiting = new Map<number, { resolve: (r: Response) => void; reject: (e: Error) => void }>();

/** Replaces fetch in a worker with one that goes through the page. */
export function installFetchProxy(scope: { fetch: typeof fetch; postMessage(m: unknown): void }): void {
  scope.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const fid = nextFid++;
    const headers: Record<string, string> = {};
    if (init?.headers) new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const req: FetchProxyRequest = {
      type: 'fetch', fid, url, method: init?.method, headers,
      body: typeof init?.body === 'string' ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : undefined,
    };
    return new Promise<Response>((resolve, reject) => {
      waiting.set(fid, { resolve, reject });
      init?.signal?.addEventListener('abort', () => {
        if (waiting.delete(fid)) reject(new DOMException('aborted', 'AbortError'));
      });
      scope.postMessage(req);
    });
  };
}

/** Handles a page reply; returns true when the message was one. */
export function handleFetchResult(msg: { type?: string }): boolean {
  if (msg.type !== 'fetchResult') return false;
  const r = msg as FetchProxyResponse;
  const w = waiting.get(r.fid);
  if (!w) return true;
  waiting.delete(r.fid);
  if (r.error !== undefined) w.reject(new TypeError(r.error));
  else w.resolve(new Response(r.status === 204 || r.status === 304 ? null : r.body, { status: r.status, headers: { 'content-type': r.contentType } }));
  return true;
}

/** Page side: performs a worker's request and posts the answer back. */
export async function serveFetch(req: FetchProxyRequest, reply: (m: FetchProxyResponse, transfer: Transferable[]) => void): Promise<void> {
  try {
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
    const body = await res.arrayBuffer();
    reply({ type: 'fetchResult', fid: req.fid, status: res.status, contentType: res.headers.get('content-type') ?? '', body }, [body]);
  } catch (e) {
    reply({ type: 'fetchResult', fid: req.fid, status: 0, contentType: '', body: null, error: String((e as Error)?.message ?? e) }, []);
  }
}
