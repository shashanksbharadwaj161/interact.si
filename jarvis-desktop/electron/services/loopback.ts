// One-shot loopback listener for an OAuth redirect (RFC 8252 section 7.3): binds 127.0.0.1 only, on the exact registered
// port, accepts GET on the exact registered path, answers every other request with 404, and closes after the first
// matching request is answered (or on close()). The response page is static text: no script, no echo of the query.
import * as http from 'node:http';
import type {LoopbackHit, LoopbackListener} from './oauth';

const page = (message: string) => `<!doctype html><meta charset="utf-8"><title>Desktop Companion</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><p style="font:16px system-ui;margin:3em">${message.replace(/[<>&"]/g, '')}</p>`;

export function listenLoopback(port: number, path: string): Promise<LoopbackListener> {
  return new Promise((resolve, reject) => {
    let pending: http.ServerResponse | null = null;
    let waiter: {resolve: (h: LoopbackHit) => void; reject: (e: Error) => void} | null = null;
    let queued: LoopbackHit | null = null;
    let closed = false;
    const server = http.createServer((req, res) => {
      let url: URL;
      try { url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`); } catch { res.writeHead(400).end(); return; }
      if (req.method !== 'GET' || url.pathname !== path || pending || queued || closed) {
        res.writeHead(404, {'content-type': 'text/plain'}).end('Not found');
        return;
      }
      pending = res;
      const hit = {path: url.pathname, query: url.searchParams};
      if (waiter) { const w = waiter; waiter = null; w.resolve(hit); } else queued = hit;
    });
    const close = () => {
      if (closed) return;
      closed = true;
      if (pending && !pending.writableEnded) pending.writeHead(410, {'content-type': 'text/plain'}).end('This sign-in has ended.');
      waiter?.reject(new Error('closed'));
      waiter = null;
      server.close();
      server.closeAllConnections?.();
    };
    server.once('error', reject);
    server.listen({host: '127.0.0.1', port, exclusive: true}, () => {
      server.removeListener('error', reject);
      resolve({
        next: () => {
          if (closed) return Promise.reject(new Error('closed'));
          if (queued) { const h = queued; queued = null; return Promise.resolve(h); }
          return new Promise((res2, rej2) => { waiter = {resolve: res2, reject: rej2}; });
        },
        finish: (ok, message) => {
          if (pending && !pending.writableEnded) pending.writeHead(ok ? 200 : 400, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'}).end(page(message));
          pending = null;
          close();
        },
        close,
      });
    });
  });
}
