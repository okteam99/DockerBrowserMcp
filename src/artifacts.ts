import { mkdir, writeFile, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { Config } from './config.js';
import { ToolError } from './errors.js';

export type Artifact = {
  id: string;
  owner: string;
  instance_id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  created_at: string;
  kind: string;
};
export class Artifacts {
  constructor(private cfg: Config) {}
  async init() {
    await mkdir(join(this.cfg.dataDir, 'artifacts'), { recursive: true, mode: 0o700 });
  }
  private path(id: string, ext = 'bin') {
    if (!/^art_[a-f0-9-]{36}$/.test(id))
      throw new ToolError('ARTIFACT_NOT_FOUND', 'Unknown artifact.');
    return join(this.cfg.dataDir, 'artifacts', `${id}.${ext}`);
  }
  async clean() {
    const dir = join(this.cfg.dataDir, 'artifacts');
    const files = await readdir(dir);
    const entries = await Promise.all(
      files.map(async (name) => ({ name, info: await stat(join(dir, name)).catch(() => null) })),
    );
    let total = entries.reduce((s, x) => s + (x.info?.size ?? 0), 0);
    for (const x of entries.sort((a, b) => (a.info?.mtimeMs ?? 0) - (b.info?.mtimeMs ?? 0))) {
      if (
        x.info &&
        (Date.now() - x.info.mtimeMs > this.cfg.retentionHours * 3600000 ||
          total > this.cfg.dataLimit)
      ) {
        await unlink(join(dir, x.name)).catch(() => {});
        total -= x.info.size;
      }
    }
  }
  private writes: Promise<unknown> = Promise.resolve();
  save(
    owner: string,
    instance: string,
    name: string,
    mime: string,
    bytes: Buffer,
    kind: string,
  ): Promise<Artifact> {
    const next = this.writes.then(() => this.saveNow(owner, instance, name, mime, bytes, kind));
    this.writes = next.catch(() => {});
    return next;
  }
  private async saveNow(
    owner: string,
    instance: string,
    name: string,
    mime: string,
    bytes: Buffer,
    kind: string,
  ) {
    await this.clean();
    if (bytes.length > this.cfg.downloadLimit)
      throw new ToolError('ARTIFACT_TOO_LARGE', 'Artifact exceeds MAX_DOWNLOAD_BYTES.');
    const files = await readdir(join(this.cfg.dataDir, 'artifacts'));
    let total = 0;
    for (const f of files) total += (await stat(join(this.cfg.dataDir, 'artifacts', f))).size;
    if (total + bytes.length + 2048 > this.cfg.dataLimit)
      throw new ToolError('STORAGE_LIMIT', 'Artifact storage quota reached.');
    const id = `art_${randomUUID()}`;
    const meta: Artifact = {
      id,
      owner,
      instance_id: instance,
      name: name.replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 200),
      mime,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      created_at: new Date().toISOString(),
      kind,
    };
    await writeFile(this.path(id), bytes, { mode: 0o600 });
    await writeFile(this.path(id, 'json'), JSON.stringify(meta), { mode: 0o600 });
    return meta;
  }
  async get(owner: string, id: string, offset = 0, length = 262144) {
    let meta: Artifact;
    try {
      meta = JSON.parse(await readFile(this.path(id, 'json'), 'utf8'));
    } catch {
      throw new ToolError('ARTIFACT_NOT_FOUND', 'Unknown or expired artifact.');
    }
    if (meta.owner !== owner) throw new ToolError('ARTIFACT_NOT_FOUND', 'Unknown artifact.');
    let bytes: Buffer;
    try {
      bytes = await readFile(this.path(id));
    } catch {
      throw new ToolError('ARTIFACT_NOT_FOUND', 'Unknown or expired artifact.');
    }
    const chunk = bytes.subarray(offset, offset + length);
    return {
      ...meta,
      data_base64: chunk.toString('base64'),
      offset,
      next_offset: offset + chunk.length,
      complete: offset + chunk.length >= bytes.length,
    };
  }
}
