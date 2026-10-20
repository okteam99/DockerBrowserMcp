import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const equal = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export class WebAuth {
  token = '';
  private salt = '';
  private hash = '';
  private sessions = new Map<string, number>();
  private attempts = new Map<string, { count: number; until: number }>();
  async init(dataDir: string, password: string) {
    const path = join(dataDir, 'web-auth.json');
    let stored: any;
    try {
      stored = JSON.parse(await readFile(path, 'utf8'));
    } catch {}
    if (stored && equal(scryptSync(password, stored.salt, 32).toString('hex'), stored.hash)) {
      this.salt = stored.salt;
      this.hash = stored.hash;
      this.token = stored.token;
    } else {
      this.salt = randomBytes(16).toString('hex');
      this.hash = scryptSync(password, this.salt, 32).toString('hex');
      this.token = randomBytes(32).toString('base64url');
      await writeFile(
        path,
        JSON.stringify({ salt: this.salt, hash: this.hash, token: this.token }),
        { mode: 0o600 },
      );
    }
  }
  login(ip: string, password: string) {
    const now = Date.now();
    for (const [key, v] of this.attempts) if (v.until < now) this.attempts.delete(key);
    const item = this.attempts.get(ip);
    if (item && item.count >= 10 && item.until > now) return { limited: true };
    const valid = equal(scryptSync(password, this.salt, 32).toString('hex'), this.hash);
    if (!valid) {
      if (this.attempts.size > 10000) this.attempts.clear();
      this.attempts.set(ip, { count: (item?.count ?? 0) + 1, until: now + 600000 });
      return { limited: false };
    }
    this.attempts.delete(ip);
    for (const [key, until] of this.sessions) if (until < now) this.sessions.delete(key);
    if (this.sessions.size >= 1000) this.sessions.delete(this.sessions.keys().next().value!);
    const session = randomBytes(32).toString('base64url');
    this.sessions.set(session, now + 86400000);
    return { session };
  }
  cookie(raw?: string) {
    const session = raw
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith('browser_session='))
      ?.slice(16);
    return session && (this.sessions.get(session) ?? 0) > Date.now() ? session : undefined;
  }
  logout(session?: string) {
    if (session) this.sessions.delete(session);
  }
  bearer(raw?: string) {
    return raw?.startsWith('Bearer ') && equal(raw.slice(7), this.token);
  }
}
