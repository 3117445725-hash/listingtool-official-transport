// Portable transport only: never signs, installs, or retries a publish.
export const ORIGIN = 'https://listingtool-user-center.3117445725.workers.dev';
export const VERSION = '/api/v1/code-update/version';
export const PUBLISH = '/api/v1/signed/code-update/publish';
export const LIMIT = 4 * 1024 * 1024;
const signedNames = ['key-id', 'timestamp', 'nonce', 'sha256', 'size', 'notes-sha256', 'signature'].map(x => 'x-listingtool-' + x);
const reply = (status, message) => new Response(JSON.stringify({error: message}), {status, headers: {'content-type':'application/json', 'cache-control':'no-store'}});
async function bounded(body) {
  if (!body) return new Uint8Array();
  const reader = body.getReader(); const chunks = []; let size = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > LIMIT) { await reader.cancel(); throw new Error('body limit'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2,'0')).join('');
export function createRelay({fetchImpl = fetch, publishEnabled = false} = {}) {
  return async function relay(request) {
    const url = new URL(request.url); const method = request.method;
    if (method === 'GET' && url.pathname === '/health' && !url.search)
      return Response.json({service:'listingtool-official-transport', publish_enabled:publishEnabled});
    if (request.headers.has('cookie') || request.headers.has('authorization') || request.headers.has('proxy-authorization'))
      return reply(400, 'browser and account credentials forbidden');
    const download = /^\/api\/v1\/code-update\/download\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(url.pathname);
    const readOnly = method === 'GET' && (url.pathname === VERSION || download) && !url.search;
    const publishing = method === 'POST' && url.pathname === PUBLISH;
    if (!readOnly && !publishing) return reply(404, 'route forbidden');
    if (publishing && !publishEnabled) return reply(503, 'signed forwarding disabled pending acceptance');
    const headers = new Headers({'user-agent':'ListingTool-Official-Transport/1'});
    let body;
    try {
      if (publishing) {
        const params = [...url.searchParams.keys()];
        if (params.length !== 3 || !['patch_version','app_version','notes'].every(x => params.includes(x)))
          return reply(400, 'exact publish query required');
        if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(url.searchParams.get('patch_version')))
          return reply(400, 'invalid immutable version');
        for (const name of signedNames) {
          const value = request.headers.get(name);
          if (!value || value.length > 512) return reply(400, 'signed header missing or invalid');
          headers.set(name, value);
        }
        if (request.headers.get('content-type') !== 'application/zip') return reply(400, 'ZIP content type required');
        const declared = Number(headers.get('x-listingtool-size'));
        if (!Number.isSafeInteger(declared) || declared < 1 || declared > LIMIT) return reply(413, 'invalid signed size');
        body = await bounded(request.body);
        if (body.byteLength !== declared || await hash(body) !== headers.get('x-listingtool-sha256') ||
            await hash(new TextEncoder().encode(url.searchParams.get('notes'))) !== headers.get('x-listingtool-notes-sha256'))
          return reply(400, 'signed body or notes mismatch');
        headers.set('content-type', 'application/zip');
      } else if (signedNames.some(x => request.headers.has(x))) return reply(400, 'signed headers forbidden on GET');
      // No caller-selected destination, redirect, cookie, key, or automatic POST retry.
      const upstream = await fetchImpl(ORIGIN + url.pathname + url.search,
        {method, headers, body, redirect:'manual', signal:AbortSignal.timeout(45000)});
      if (upstream.status >= 300 && upstream.status < 400) return reply(502, 'upstream redirect forbidden');
      const bytes = await bounded(upstream.body);
      const range = request.headers.get('range');
      if (range && (publishing || !download)) return reply(400, 'range only for immutable downloads');
      if (range && upstream.status === 200) {
        const match = /^bytes=(\d+)-(\d+)$/.exec(range);
        if (!match) return reply(416, 'explicit byte range required');
        const start=Number(match[1]), end=Number(match[2]);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start>end || end>=bytes.length || end-start+1>128*1024)
          return reply(416, 'bounded range outside immutable file');
        const slice=bytes.slice(start,end+1);
        return new Response(slice,{status:206,headers:{'content-type':'application/octet-stream','content-length':String(slice.length),
          'content-range':`bytes ${start}-${end}/${bytes.length}`,'cache-control':'no-store','x-content-type-options':'nosniff'}});
      }
      return new Response(bytes, {status:upstream.status, headers:{
        'content-type':upstream.headers.get('content-type') || 'application/octet-stream',
        'content-length':String(bytes.length),'cache-control':'no-store', 'x-content-type-options':'nosniff'}});
    } catch {
      // POST may have reached Worker: caller MUST reconcile through GET before retry.
      return reply(502, publishing ? 'publish outcome unresolved; read-only reconciliation required' : 'official read failed');
    }
  };
}
export default {fetch:createRelay()};
