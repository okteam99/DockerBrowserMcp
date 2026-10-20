import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
test('release dry-run uses fixed Docker Hub namespace, timestamp tag and multiarch without exposing token', () => {
  const result = spawnSync('bash', ['scripts/publish-docker.sh', '--dry-run'], {
    env: {
      ...process.env,
      RELEASE_TAG: '20261020123456',
      DOCKERHUB_TOKEN: 'test-secret-never-print',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /bdpgogoup\/dockerbrowsermcp:20261020123456/);
  assert.match(result.stdout, /linux\/amd64,linux\/arm64/);
  assert.match(result.stdout, /--push/);
  assert.ok(!result.stdout.includes('test-secret-never-print'));
  assert.equal(
    spawnSync('bash', ['scripts/publish-docker.sh', '--dry-run'], {
      env: { ...process.env, RELEASE_TAG: 'bad-tag' },
      encoding: 'utf8',
    }).status,
    2,
  );
});
