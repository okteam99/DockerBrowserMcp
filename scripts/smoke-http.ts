import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const base = (process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const password = process.env.SMOKE_PASSWORD;
if (!password) throw Error('Set SMOKE_PASSWORD to the test deployment password.');
let client: Client | undefined, instance: string | undefined;
try {
  const login = await fetch(base + '/login', {
    method: 'POST',
    body: new URLSearchParams({ password }),
    redirect: 'manual',
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const info: any = await (
    await fetch(base + '/api/connection', { headers: { Cookie: cookie } })
  ).json();
  client = new Client({ name: 'http-smoke', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(info.mcp_url), {
      requestInit: { headers: info.mcp_config.mcpServers['docker-browser'].headers },
    }),
  );
  const tools = await client.listTools();
  assert.ok(tools.tools.some((t) => t.name === 'list_recordings'));
  const created: any = await client.callTool({
    name: 'create_instance',
    arguments: { viewport: { width: 390, height: 844 } },
  });
  const result = JSON.parse(created.content[0].text);
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  instance = result.data.instance_id;
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), 10000);
  deadline.unref();
  const live = await fetch(`${base}/api/instances/${instance}/live`, {
    headers: { Cookie: cookie },
    signal: abort.signal,
  });
  assert.equal(live.status, 200);
  const reader = live.body!.getReader();
  let frame = Buffer.alloc(0);
  for (let n = 0; n < 10; n++) {
    const part = await reader.read();
    frame = Buffer.concat([frame, Buffer.from(part.value ?? [])]);
    if (frame.includes(Buffer.from([255, 216]))) break;
  }
  abort.abort();
  clearTimeout(deadline);
  assert.ok(frame.includes(Buffer.from([255, 216])));
  const closed: any = await client.callTool({
    name: 'close_instance',
    arguments: { instance_id: instance },
  });
  assert.equal(JSON.parse(closed.content[0].text).status, 'succeeded');
  const history: any[] = (await (
    await fetch(base + '/api/recordings', { headers: { Cookie: cookie } })
  ).json()) as any[];
  const recording = history.find((r) => r.instance_id === instance);
  assert.equal(recording.status, 'completed', JSON.stringify(recording));
  const response = await fetch(`${base}/api/recordings/${recording.id}/video`, {
    headers: { Cookie: cookie, Range: 'bytes=0-3' },
  });
  assert.equal(response.status, 206);
  assert.equal(Buffer.from(await response.arrayBuffer()).toString('hex'), '1a45dfa3');
  instance = undefined;
  console.log(
    `HTTP MCP smoke passed: ${tools.tools.length} tools, password login, authenticated connection, live JPEG, WebM recording and playback`,
  );
} finally {
  if (instance)
    await client
      ?.callTool({ name: 'close_instance', arguments: { instance_id: instance } })
      .catch(() => {});
  await client?.close();
}
