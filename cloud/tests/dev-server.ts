import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTestDB } from './sqlite-adapter';
import type { createWorker } from '../worker/index';

const db = createTestDB();
db.sqlite.prepare("INSERT INTO User(id,providerId,name,email,role,active) VALUES(?,?,?,?,?,1)")
  .run('local-reception', 'local-reception', 'Тестовый приёмщик', 'reception@example.invalid', 'RECEPTION');
const { default: worker } = await import(pathToFileURL(resolve('dist/server/index.js')).href) as {
  default: ReturnType<typeof createWorker>;
};
const port = Number(process.env.PORT ?? 4173);
const hostname = process.env.HOST ?? '127.0.0.1';

const server = createServer(async (incoming, outgoing) => {
  try {
    const authority = incoming.headers.host ?? `localhost:${port}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    headers.set('oai-authenticated-user-id', 'local-reception');
    headers.set('oai-authenticated-user-email', 'reception@example.invalid');
    const origin = headers.get('origin');
    // Managed preview sometimes terminates TLS before forwarding to the dev server.
    const scheme = origin && new URL(origin).host === authority
      ? new URL(origin).protocol : 'http:';
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const request = new Request(`${scheme}//${authority}${incoming.url}`, {
      method: incoming.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    const response = await worker.fetch(request, { DB: db });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) outgoing.end(Buffer.from(await response.arrayBuffer()));
    else outgoing.end();
  } catch (error) {
    console.error(error);
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.end();
  }
});
server.listen(port, hostname, () => console.log(`SQLite preview: http://${hostname}:${port}`));
