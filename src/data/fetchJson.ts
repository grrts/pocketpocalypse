/** Fetch JSON that may be stored gzip-compressed (.json.gz). Handles hosts that
 * already strip the compression via Content-Encoding. */
export async function fetchMaybeGzipJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  return parseMaybeGzipJson<T>(buf);
}

export async function parseMaybeGzipJson<T>(buf: Uint8Array): Promise<T> {
  let bytes = buf;
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([buf as BlobPart]).stream().pipeThrough(ds);
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}
