import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkPolicy, isPublicAddress } from '../src/network.js';
import { createSchema, proxySchema } from '../src/config.js';

test('private, mapped, reserved and metadata IPs are denied', async () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    '192.168.1.1',
    '0.0.0.0',
  ])
    assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  const policy = new NetworkPolicy({ allowPrivate: false, allowedHosts: [] });
  for (const u of [
    'http://127.0.0.1',
    'http://[::1]',
    'file:///etc/passwd',
    'http://169.254.169.254',
    'http://user:pass@example.com',
    'http://2130706433',
  ])
    await assert.rejects(() => policy.url(u));
});
test('allowlist is exact or explicit subdomain wildcard', async () => {
  const p = new NetworkPolicy({
    allowPrivate: true,
    allowedHosts: ['example.com', '*.example.org'],
  });
  await p.url('https://example.com/');
  await p.url('https://sub.example.org/');
  await assert.rejects(() => p.url('https://example.com.evil.test'));
});
test('proxy and instance input reject unsafe/ambiguous configuration', () => {
  assert.equal(
    proxySchema.safeParse({ server: 'socks5://host:1080', username: 'a', password: 'b' }).success,
    true,
  );
  for (const server of ['ftp://host:21', 'http://user:secret@host:80', 'http://host:80/path'])
    assert.equal(proxySchema.safeParse({ server }).success, false);
  assert.equal(
    createSchema.safeParse({ proxy: { server: 'http://host:80' }, proxy_ref: 'uk' }).success,
    false,
  );
});
