import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { ToolError } from './errors.js';

export type Share = {
  share_id: string;
  owner: string;
  kind: 'live' | 'recording';
  resource_id: string;
  created_at: string;
  expires_at: string;
  revoked_at?: string;
  token_hash: string;
};
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
export class ShareStore {
  private entries = new Map<string, Share>();
  private pending: Promise<unknown> = Promise.resolve();
  private file: string;
  constructor(
    private dir: string,
    private now = () => Date.now(),
  ) {
    this.file = join(dir, 'shares.json');
  }
  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      const entries = JSON.parse(await readFile(this.file, 'utf8')) as Share[];
      if (!Array.isArray(entries)) throw Error('Invalid share store');
      this.entries = new Map(entries.map((s) => [s.share_id, s]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  private active(s: Share) {
    return !s.revoked_at && Date.parse(s.expires_at) > this.now();
  }
  private mutate<T>(change: (entries: Map<string, Share>) => T): Promise<T> {
    const operation = this.pending.then(async () => {
      const next = new Map(this.entries);
      const result = change(next);
      await writeFile(this.file + '.tmp', JSON.stringify([...next.values()]), { mode: 0o600 });
      await rename(this.file + '.tmp', this.file);
      this.entries = next;
      return result;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  describe(s: Share) {
    const { owner: _owner, token_hash: _hash, ...metadata } = s;
    return {
      ...metadata,
      status: s.revoked_at ? 'revoked' : this.active(s) ? 'active' : 'expired',
    };
  }
  async create(owner: string, kind: Share['kind'], resource: string, ttl: number) {
    return this.mutate((entries) => {
      for (const [id, s] of entries) if (!this.active(s)) entries.delete(id);
      if (entries.size >= 1000)
        throw new ToolError('SHARE_LIMIT', 'At most 1000 active share links.');
      const token = randomBytes(32).toString('base64url');
      const share: Share = {
        share_id: 'shr_' + randomUUID(),
        owner,
        kind,
        resource_id: resource,
        created_at: new Date(this.now()).toISOString(),
        expires_at: new Date(this.now() + ttl * 1000).toISOString(),
        token_hash: hash(token),
      };
      entries.set(share.share_id, share);
      return { ...this.describe(share), token };
    });
  }
  resolve(token: string): Share | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    const digest = hash(token);
    return [...this.entries.values()].find((s) => s.token_hash === digest && this.active(s));
  }
  list(owner: string) {
    return [...this.entries.values()].filter((s) => s.owner === owner).map((s) => this.describe(s));
  }
  async revoke(owner: string, id: string) {
    return this.mutate((entries) => {
      const s = entries.get(id);
      if (!s || s.owner !== owner) throw new ToolError('SHARE_NOT_FOUND', 'Unknown share link.');
      const next = { ...s, revoked_at: s.revoked_at ?? new Date(this.now()).toISOString() };
      entries.set(id, next);
      return this.describe(next);
    });
  }
}
