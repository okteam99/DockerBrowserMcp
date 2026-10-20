import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebAuth } from '../src/auth.js';
import { config } from '../src/config.js';
import { chromium } from 'playwright';

const freePort = async () => {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as any).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
};
const stop = async (p: ChildProcess) => {
  if (p.exitCode !== null) return;
  const end = new Promise<void>((r) => p.once('exit', () => r()));
  p.kill('SIGTERM');
  await end;
};
test('default concurrency is 10 and password changes rotate persisted MCP token', async () => {
  assert.equal(config().maxInstances, 10);
  const dir = await mkdtemp(join(tmpdir(), 'mcp-auth-'));
  try {
    const a = new WebAuth();
    await a.init(dir, 'old-password');
    const token = a.token;
    assert.ok(a.login('a', 'old-password').session);
    assert.equal(a.login('a', 'wrong').session, undefined);
    const b = new WebAuth();
    await b.init(dir, 'old-password');
    assert.equal(b.token, token);
    const c = new WebAuth();
    await c.init(dir, 'new-password');
    assert.notEqual(c.token, token);
    assert.equal(c.bearer('Bearer ' + token), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('password web portal, BASE_URL prefix, authenticated HTTP MCP, live JPEG and persistent video playback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-web-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}/browser`;
  const fixture = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(
      '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Live fixture</title><h1>Live recording test</h1><button onclick="document.body.style.background=\'green\'">Change</button>',
    );
  });
  await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
  const fixtureUrl = `http://127.0.0.1:${(fixture.address() as any).port}`;
  let logs = '';
  const start = async () => {
    const p = spawn(process.execPath, ['dist/cli.js', 'daemon'], {
      env: {
        ...process.env,
        DATA_DIR: dir,
        MCP_SOCKET: join(dir, 'service.sock'),
        BASE_URL: base,
        WEB_PASSWORD: 'test-password-123',
        WEB_PORT: String(port),
        ALLOW_PRIVATE_NETWORKS: 'true',
        MAX_INSTANCES: '1',
        RECORD_VIDEO: 'true',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    p.stderr!.on('data', (c) => (logs += c));
    let ready = false;
    for (let n = 0; n < 100; n++) {
      try {
        if ((await fetch(base + '/healthz')).ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(ready, logs);
    return p;
  };
  let proc = await start();
  let client: Client | undefined;
  try {
    const invalid = await new Promise<number>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: 'http://[' }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.end();
    });
    assert.equal(invalid, 400);
    const root = await fetch(base);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /访问密码/);
    assert.equal((await fetch(base + '/api/connection')).status, 401);
    assert.equal((await fetch(base + '/mcp', { method: 'POST', body: '{}' })).status, 401);
    assert.equal(
      (
        await fetch(base + '/login', {
          method: 'POST',
          body: new URLSearchParams({ password: 'wrong' }),
          redirect: 'manual',
        })
      ).status,
      401,
    );
    const login = await fetch(base + '/login', {
      method: 'POST',
      body: new URLSearchParams({ password: 'test-password-123' }),
      redirect: 'manual',
    });
    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const headers = { Cookie: cookie };
    assert.match(await (await fetch(base + '/', { headers })).text(), /复制完整 Agent 接入说明/);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(5000);
      await page.goto(base + '/');
      await page.getByLabel('访问密码').fill('test-password-123');
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await page
        .getByRole('button', { name: '复制完整 Agent 接入说明' })
        .waitFor({ timeout: 5000 });
      await page.waitForFunction(
        () => document.getElementById('config')?.textContent?.includes('Bearer '),
        undefined,
        { timeout: 5000 },
      );
    } finally {
      await browser.close();
    }

    const connection: any = await (await fetch(base + '/api/connection', { headers })).json();
    assert.equal(connection.mcp_url, base + '/mcp');
    assert.equal(connection.max_instances, 1);
    assert.match(connection.agent_instructions, /create_instance/);
    const auth = connection.mcp_config.mcpServers['docker-browser'].headers;
    assert.ok(auth.Authorization.startsWith('Bearer '));
    assert.ok(!connection.mcp_url.includes(auth.Authorization.slice(7)));
    assert.equal(
      (
        await fetch(base + '/api/connection', {
          headers: { ...headers, Origin: 'https://evil.test' },
        })
      ).status,
      403,
    );
    assert.equal((await fetch(base + '/docs/mcp-api.md', { headers })).status, 200);
    client = new Client({ name: 'web-test', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(connection.mcp_url), {
        requestInit: { headers: auth },
      }),
    );
    assert.equal((await client.listTools()).tools.length, 25);
    const call = async (name: string, args: any = {}) => {
      const r: any = await client!.callTool({ name, arguments: args });
      return JSON.parse(r.content[0].text);
    };
    const result = await call('create_instance', {
      viewport: { width: 390, height: 844 },
      mobile: { enabled: true, touch: true, device_scale_factor: 2 },
    });
    assert.equal(result.status, 'succeeded', JSON.stringify(result));
    const id = result.data.instance_id;
    const ids = { instance_id: id, page_id: result.data.pages[0].page_id };
    assert.equal((await call('create_instance')).error.code, 'INSTANCE_LIMIT');
    await call('navigate', { ...ids, url: fixtureUrl });
    await call('interact', { ...ids, action: 'click', target: { role: 'button', name: 'Change' } });
    const api: any = await (await fetch(base + '/api/instances', { headers })).json();
    assert.equal(api.instances[0].instance_id, id);
    const abort = new AbortController();
    const liveDeadline = setTimeout(() => abort.abort(), 10000);
    liveDeadline.unref();
    const live = await fetch(`${base}/api/instances/${id}/live`, { headers, signal: abort.signal });
    assert.match(live.headers.get('content-type')!, /multipart/);
    const reader = live.body!.getReader();
    let captured = Buffer.alloc(0);
    for (let n = 0; n < 10; n++) {
      const item = await reader.read();
      captured = Buffer.concat([captured, Buffer.from(item.value ?? [])]);
      if (captured.includes(Buffer.from([255, 216]))) break;
    }
    assert.ok(captured.includes(Buffer.from([255, 216])), 'Live stream must contain JPEG data');
    abort.abort();
    clearTimeout(liveDeadline);
    await new Promise((r) => setTimeout(r, 1400));
    await call('close_instance', { instance_id: id });
    let history: any[] = [];
    for (let n = 0; n < 20; n++) {
      history = (await (await fetch(base + '/api/recordings', { headers })).json()) as any[];
      if (history[0]?.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(history[0].status, 'completed', JSON.stringify(history));
    assert.ok(history[0].frames >= 2);
    assert.ok(history[0].bytes > 0);
    assert.equal(history[0].fps, 2);
    const playback = `${base}/api/recordings/${history[0].id}/video`;
    assert.equal((await fetch(playback)).status, 401);
    const part = await fetch(playback, { headers: { ...headers, Range: 'bytes=0-3' } });
    assert.equal(part.status, 206);
    assert.equal(Buffer.from(await part.arrayBuffer()).toString('hex'), '1a45dfa3');
    assert.equal((await call('list_recordings')).data[0].id, history[0].id);
    const recordingsBefore = history.length;
    await client.close();
    client = undefined;
    await stop(proc);
    proc = await start();
    assert.equal(
      (await fetch(base + '/api/connection', { headers })).status,
      401,
      'Sessions expire on restart',
    );
    const persisted = await fetch(base + '/api/recordings', { headers: auth });
    assert.equal(persisted.status, 200);
    assert.equal(((await persisted.json()) as any[]).length, recordingsBefore);
    const range = await fetch(playback, { headers: { ...auth, Range: 'bytes=999999999999-' } });
    assert.equal(range.status, 416);
  } finally {
    await client?.close();
    await stop(proc);
    await new Promise<void>((r) => fixture.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
