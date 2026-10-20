import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ShareStore } from '../src/shares.js';
import { BrowserManager } from '../src/browser.js';
import { config } from '../src/config.js';
import { definitions } from '../src/tools.js';

test('share capabilities persist as hashes, expire, revoke and isolate owners under concurrent writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-shares-'));
  let now = Date.now();
  try {
    const store = new ShareStore(dir, () => now);
    await store.init();
    const [a, b] = await Promise.all([
      store.create('alice', 'live', 'instance-a', 60),
      store.create('bob', 'recording', 'recording-b', 120),
    ]);
    assert.equal(a.token.length, 43);
    assert.notEqual(a.token, b.token);
    assert.equal(store.resolve(a.token)?.resource_id, 'instance-a');
    assert.equal(store.resolve(a.token)?.kind, 'live');
    assert.deepEqual(store.list('other'), []);
    assert.equal(store.list('alice').length, 1);
    const persisted = await readFile(join(dir, 'shares.json'), 'utf8');
    assert.ok(!persisted.includes(a.token));
    assert.ok(!JSON.stringify(store.list('alice')).includes('token_hash'));
    await assert.rejects(store.revoke('bob', a.share_id), { code: 'SHARE_NOT_FOUND' });
    assert.ok(store.resolve(a.token));
    const restarted = new ShareStore(dir, () => now);
    await restarted.init();
    assert.ok(restarted.resolve(a.token));
    await restarted.revoke('alice', a.share_id);
    assert.equal(restarted.resolve(a.token), undefined);
    assert.equal(restarted.list('alice')[0].status, 'revoked');
    now += 120000;
    assert.equal(restarted.resolve(b.token), undefined);
    assert.equal(restarted.list('bob')[0].status, 'expired');
    assert.equal(restarted.resolve('not-a-token'), undefined);
    assert.equal(restarted.resolve('x'.repeat(43)), undefined);
    const again = new ShareStore(dir, () => now);
    await again.init();
    assert.equal(again.resolve(a.token), undefined);
    assert.equal(again.resolve(b.token), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('MCP sharing validates scope, ownership, resource readiness and web availability', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-share-owner-'));
  const manager = new BrowserManager({
    ...config(),
    dataDir: dir,
    webPort: 8080,
    baseUrl: 'https://browser.example/browser',
  });
  try {
    await manager.init();
    const id = 'rec_00000000-0000-0000-0000-000000000001';
    await manager.recordings.persist({
      id,
      instance_id: 'ins_test',
      owner: 'alice',
      created_at: new Date().toISOString(),
      status: 'completed',
      frames: 1,
      fps: 2,
      width: 640,
      height: 480,
      bytes: 4,
    });
    await writeFile(manager.recordings.path(id), Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    const schema = definitions.create_share_link.schema;
    for (const args of [
      { kind: 'live', recording_id: id },
      { kind: 'recording', instance_id: 'ins_test' },
      { kind: 'live', instance_id: 'ins_test', recording_id: id },
      { kind: 'live', instance_id: 'ins_test', expires_in_seconds: 0 },
      { kind: 'live', instance_id: 'ins_test', expires_in_seconds: 2592001 },
    ])
      assert.equal(schema.safeParse(args).success, false);
    const args = schema.parse({ kind: 'recording', recording_id: id });
    await assert.rejects(manager.execute('bob', 'create_share_link', args), {
      code: 'RECORDING_NOT_FOUND',
    });
    await assert.rejects(
      manager.execute(
        'bob',
        'create_share_link',
        schema.parse({ kind: 'live', instance_id: 'ins_test' }),
      ),
      { code: 'INSTANCE_NOT_FOUND' },
    );
    const shared = await manager.execute('alice', 'create_share_link', args);
    assert.ok(shared.url.startsWith('https://browser.example/browser/share/'));
    assert.deepEqual(await manager.execute('bob', 'list_share_links', {}), []);
    await assert.rejects(
      manager.execute('bob', 'revoke_share_link', { share_id: shared.share_id }),
      { code: 'SHARE_NOT_FOUND' },
    );
    manager.cfg.webPort = 0;
    await assert.rejects(manager.execute('alice', 'create_share_link', args), {
      code: 'SHARING_DISABLED',
    });
    manager.cfg.webPort = 8080;
    await rm(manager.recordings.path(id));
    await assert.rejects(manager.execute('alice', 'create_share_link', args), {
      code: 'RECORDING_NOT_FOUND',
    });
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});
