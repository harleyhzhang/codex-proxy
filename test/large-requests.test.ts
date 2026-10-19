import { expect, test } from 'bun:test';
import { AUTH_HEADERS, fixtureRouter } from './support';

// A short follow-up still carries earlier image/tool output. Exercise the real listeners:
// compressed HTTP must be checked after decompression, and Bun's WebSocket default is 16 MiB.
for (const transport of ['http', 'zstd', 'websocket'] as const) {
  test(`image-heavy history above 32 MiB reaches upstream intact over ${transport}`, async () => {
    const image = 'data:image/png;base64,' + 'A'.repeat(33 * 1024 * 1024);
    const payload = { model: 'gpt-fixture', input: [{ role: 'user', content: [{ type: 'input_image', image_url: image }] }] };
    let seenImage: unknown;
    const app = await fixtureRouter({ upstreamFetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      seenImage = body.input[0].content[0].image_url;
      return new Response('data: {"type":"response.completed","response":{"id":"large-fixture","output":[]}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    } });
    try {
      if (transport === 'websocket') {
        await new Promise<void>((resolve, reject) => {
          const Socket = WebSocket as unknown as { new (url: string, options: { headers: Record<string, string> }): WebSocket };
          const ws = new Socket(app.url('/v1/responses').replace('http:', 'ws:'), { headers: AUTH_HEADERS });
          ws.onopen = () => ws.send(JSON.stringify({ type: 'response.create', ...payload }));
          ws.onmessage = ({ data }) => {
            const event = JSON.parse(String(data));
            if (event.type === 'response.completed') { resolve(); ws.close(); }
            else if (event.type === 'error' || event.type === 'response.failed') { reject(new Error(String(data))); ws.close(); }
          };
          ws.onerror = () => reject(new Error('socket failed'));
          ws.onclose = () => reject(new Error('socket closed before completion'));
        });
      } else {
        const json = JSON.stringify(payload);
        const body = transport === 'zstd' ? new Uint8Array(Bun.zstdCompressSync(Buffer.from(json))) : json;
        const response = await fetch(app.url('/v1/responses'), { method: 'POST', headers: { ...AUTH_HEADERS, ...(transport === 'zstd' ? { 'content-encoding': 'zstd' } : {}) }, body });
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('response.completed');
      }
      expect(seenImage).toBe(image);
    } finally { await app.close(); }
  }, 15_000);
}
