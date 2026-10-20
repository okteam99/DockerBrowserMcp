import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

export const proxySchema = z
  .object({
    server: z.string().url(),
    username: z.string().max(512).optional(),
    password: z.string().max(512).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const u = new URL(v.server);
    if (
      !['http:', 'https:', 'socks5:'].includes(u.protocol) ||
      u.username ||
      u.password ||
      (u.pathname && u.pathname !== '/') ||
      u.search ||
      u.hash
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Use http://, https:// or socks5://host:port; credentials must be separate fields',
      });
  });
export const createSchema = z
  .object({
    user_agent: z.string().min(1).max(1024).optional(),
    viewport: z
      .object({
        width: z.number().int().min(240).max(3840),
        height: z.number().int().min(240).max(3840),
      })
      .default({ width: 1280, height: 720 }),
    proxy: proxySchema.optional(),
    proxy_ref: z.string().max(128).optional(),
    mobile: z
      .object({
        enabled: z.boolean().default(true),
        touch: z.boolean().default(true),
        device_scale_factor: z.number().min(1).max(4).default(1),
      })
      .optional(),
    locale: z.string().max(64).default('en-US'),
    timezone: z.string().max(128).default('UTC'),
    idle_timeout_seconds: z.number().int().min(30).max(3600).default(600),
    max_lifetime_seconds: z.number().int().min(60).max(14400).default(3600),
  })
  .strict()
  .refine((v) => !(v.proxy && v.proxy_ref), 'proxy and proxy_ref are mutually exclusive');
export type Proxy = z.infer<typeof proxySchema>;
export type InstanceOptions = z.infer<typeof createSchema>;
const integer = (name: string, fallback: number, min: number, max: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
};
export function config() {
  return {
    dataDir: resolve(process.env.DATA_DIR ?? './data'),
    socket: process.env.MCP_SOCKET ?? '/tmp/docker-browser-mcp.sock',
    proxyFile: process.env.PROXY_CONFIG ?? '/config/proxies.json',
    maxInstances: integer('MAX_INSTANCES', 3, 1, 20),
    maxPages: integer('MAX_PAGES', 10, 1, 100),
    timeout: integer('ACTION_TIMEOUT_MS', 15000, 1000, 60000),
    downloadLimit: integer('MAX_DOWNLOAD_BYTES', 52428800, 1024, 1073741824),
    retentionHours: integer('ARTIFACT_RETENTION_HOURS', 168, 1, 8760),
    dataLimit: integer('MAX_DATA_BYTES', 1073741824, 1048576, Number.MAX_SAFE_INTEGER),
    allowPrivate: process.env.ALLOW_PRIVATE_NETWORKS === 'true',
    allowedHosts: (process.env.ALLOWED_HOSTS ?? '')
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean),
  };
}
export type Config = ReturnType<typeof config>;
export async function loadProxies(
  file: string,
): Promise<Record<string, Proxy & { country?: string }>> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    return z
      .record(
        z
          .object({
            server: z.string(),
            username: z.string().optional(),
            password: z.string().optional(),
            country: z.string().optional(),
          })
          .strict(),
      )
      .parse(raw);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error('Invalid proxy configuration file');
  }
}
