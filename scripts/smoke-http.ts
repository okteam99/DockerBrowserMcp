import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const base = (process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const password = process.env.SMOKE_PASSWORD;
if (!password) throw Error('Set SMOKE_PASSWORD to the test deployment password.');
let client: Client | undefined, instance: string | undefined;
const shares: string[] = [];
const call = async (name: string, args: Record<string, unknown>) => {
  const result: any = await client!.callTool({ name, arguments: args });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.status, 'succeeded', JSON.stringify(parsed));
  return parsed.data;
};
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
  const sharedLive = await call('create_share_link', { kind: 'live', instance_id: instance });
  shares.push(sharedLive.share_id);
  assert.equal((await fetch(sharedLive.url)).status, 200);
  const sharedAbort = new AbortController();
  const sharedDeadline = setTimeout(() => sharedAbort.abort(), 10000);
  try {
    const sharedStream = await fetch(sharedLive.media_url, { signal: sharedAbort.signal });
    assert.equal(sharedStream.status, 200);
    const sharedReader = sharedStream.body!.getReader();
    let sharedFrame = Buffer.alloc(0);
    while (!sharedFrame.includes(Buffer.from([255, 216]))) {
      const next = await sharedReader.read();
      assert.equal(next.done, false);
      sharedFrame = Buffer.concat([sharedFrame, Buffer.from(next.value!)]);
    }
  } finally {
    sharedAbort.abort();
    clearTimeout(sharedDeadline);
  }
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
  const sharedRecording = await call('create_share_link', {
    kind: 'recording',
    recording_id: recording.id,
  });
  shares.push(sharedRecording.share_id);
  const publicVideo = await fetch(sharedRecording.media_url, { headers: { Range: 'bytes=0-3' } });
  assert.equal(publicVideo.status, 206);
  assert.equal(Buffer.from(await publicVideo.arrayBuffer()).toString('hex'), '1a45dfa3');
  await call('revoke_share_link', { share_id: sharedRecording.share_id });
  assert.equal((await fetch(sharedRecording.media_url)).status, 404);
  instance = undefined;
  console.log(
    `HTTP MCP smoke passed: ${tools.tools.length} tools, password login, authenticated connection, live JPEG, WebM playback, public share links and revocation`,
  );
} finally {
  for (const share_id of shares)
    await client?.callTool({ name: 'revoke_share_link', arguments: { share_id } }).catch(() => {});
  if (instance)
    await client
      ?.callTool({ name: 'close_instance', arguments: { instance_id: instance } })
      .catch(() => {});
  await client?.close();
}
