import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { ADMIN, buildTestApp } from './helpers.js';

/** Minimal SSE client: opens the stream and reads frames until one of the requested type arrives. */
async function openEventStream(url: string, signal: AbortSignal) {
  const res = await fetch(url, { signal });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';

  return async function nextEvent(type: string) {
    for (;;) {
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      const match = frames.findIndex((f) => f.includes(`event: ${type}\n`));
      if (match !== -1) {
        buffer = frames.slice(match + 1).join('\n\n') + (frames.length > match + 1 ? '\n\n' : '') + buffer;
        const data = frames[match]!.split('\n').find((l) => l.startsWith('data: '))!;
        return JSON.parse(data.slice('data: '.length));
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('stream closed');
      buffer += value;
    }
  };
}

describe('real-time events (SSE)', () => {
  it('emits disaster_created and disaster_updated to connected clients', async () => {
    const { app } = buildTestApp();
    const server = app.listen(0);
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const abort = new AbortController();
    const post = (path: string, method: string, body: unknown) =>
      fetch(`${baseUrl}${path}`, {
        method,
        headers: { ...ADMIN, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json());

    try {
      const nextEvent = await openEventStream(`${baseUrl}/events`, abort.signal);
      await nextEvent('connected'); // subscription is live

      const disaster = await post('/disasters', 'POST', { title: 'Quake', description: 'Strong earthquake near Tokyo' });
      expect(await nextEvent('disaster_created')).toMatchObject({
        type: 'disaster_created',
        actor: 'admin',
        disaster: { id: disaster.id },
      });

      await post(`/disasters/${disaster.id}`, 'PATCH', { status: 'verified' });
      expect(await nextEvent('disaster_updated')).toMatchObject({
        type: 'disaster_updated',
        disaster: { id: disaster.id, status: 'verified' },
      });
    } finally {
      abort.abort();
      server.closeAllConnections();
      server.close();
    }
  });
});
