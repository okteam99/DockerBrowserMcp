import http from 'node:http';
import { mkdir, chmod, unlink, open, readFile, stat, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BrowserManager } from './browser.js';
import { definitions } from './tools.js';
import { config } from './config.js';
import { publicError, ToolError } from './errors.js';
import { startWeb } from './web.js';
import type { Dispatch } from './mcp.js';
import { startCloudflareTunnel, validateTunnelConfig } from './tunnel.js';

export async function daemon() {
  process.umask(0o077);
  const cfg = config();
  validateTunnelConfig(cfg);
  const manager = new BrowserManager(cfg);
  await mkdir(dirname(cfg.socket), { recursive: true });
  try {
    const pid = Number(await readFile(`${cfg.socket}.lock`, 'utf8'));
    if (!Number.isInteger(pid) || pid < 1) throw Error('Invalid manager lock');
    let alive = pid !== process.pid;
    if (alive) {
      try {
        process.kill(pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
        else throw e;
      }
    }
    if (alive) throw Error('Another manager owns this socket');
    await unlink(`${cfg.socket}.lock`);
    await unlink(cfg.socket).catch(() => {});
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const lock = await open(`${cfg.socket}.lock`, 'wx', 0o600);
  await lock.writeFile(String(process.pid));
  await manager.init();
  const operations = new Map<
    string,
    { owner: string; name: string; created_at: string; promise: Promise<any>; result?: any }
  >();
  const order: string[] = [];
  const auditPath = `${cfg.dataDir}/audit.jsonl`;
  if (((await stat(auditPath).catch(() => null))?.size ?? 0) >= 5242880)
    await rename(auditPath, `${cfg.dataDir}/audit.previous.jsonl`);
  const audit = await open(auditPath, 'a', 0o600);
  const dispatch: Dispatch = async (owner, name, args, operationId) => {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(owner))
      throw new ToolError('INVALID_PRINCIPAL', 'Invalid principal.');
    const def = definitions[name];
    if (!def) throw new ToolError('UNKNOWN_TOOL', 'Unknown tool.');
    const parsed = def.schema.parse(args);
    if (name === 'list_operations')
      return {
        operation_id: operationId,
        status: 'succeeded',
        data: Array.from(operations, ([operation_id, op]) => ({
          operation_id,
          owner: op.owner,
          tool: op.name,
          created_at: op.created_at,
          status: op.result?.status ?? 'running',
        }))
          .filter((op) => op.owner === owner)
          .slice(-parsed.limit),
        error: null,
      };
    if (name === 'get_operation') {
      const op = operations.get(String(parsed.operation_id));
      if (!op || op.owner !== owner)
        throw new ToolError('OPERATION_NOT_FOUND', 'Unknown or expired operation.');
      return {
        operation_id: operationId,
        status: 'succeeded',
        data: op.result ?? { operation_id: parsed.operation_id, status: 'running' },
        error: null,
      };
    }
    const old = operations.get(operationId);
    if (old) {
      if (old.owner !== owner) throw new ToolError('OPERATION_NOT_FOUND', 'Unknown operation.');
      return old.promise;
    }
    const promise = (async () => {
      const started = Date.now();
      let result: any;
      try {
        result = {
          operation_id: operationId,
          status: 'succeeded',
          data: await manager.execute(owner, name, parsed),
          error: null,
        };
      } catch (e) {
        result = {
          operation_id: operationId,
          status: 'failed',
          data: null,
          error:
            e instanceof z.ZodError
              ? { code: 'INVALID_ARGUMENT', message: 'Invalid arguments.' }
              : publicError(e),
        };
      }
      const entry = operations.get(operationId);
      if (entry) entry.result = result;
      try {
        if ((await stat(auditPath)).size < 5242880)
          await audit.appendFile(
            JSON.stringify({
              time: new Date().toISOString(),
              owner,
              tool: name,
              operation_id: operationId,
              status: result.status,
              error_code: result.error?.code,
              elapsed_ms: Date.now() - started,
            }) + '\n',
          );
      } catch {
        process.stderr.write('Audit append failed; operation result preserved\n');
      }
      return result;
    })();
    operations.set(operationId, { owner, name, created_at: new Date().toISOString(), promise });
    order.push(operationId);
    if (order.length > 500) operations.delete(order.shift()!);
    return promise;
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    try {
      if (req.url === '/health' && req.method === 'GET') {
        res.end('{"status":"ok"}');
        return;
      }
      if (req.url !== '/call' || req.method !== 'POST')
        throw new ToolError('NOT_FOUND', 'Unknown endpoint.');
      let raw = '';
      for await (const chunk of req) {
        raw += chunk.toString();
        if (Buffer.byteLength(raw) > 1048576)
          throw new ToolError('REQUEST_TOO_LARGE', 'Request exceeds 1 MiB');
      }
      const call = z
        .object({
          owner: z.string(),
          name: z.string(),
          args: z.record(z.unknown()),
          operation_id: z.string().uuid(),
        })
        .parse(JSON.parse(raw));
      res.end(JSON.stringify(await dispatch(call.owner, call.name, call.args, call.operation_id)));
    } catch (e) {
      res.statusCode = 400;
      res.end(
        JSON.stringify({
          operation_id: randomUUID(),
          status: 'failed',
          data: null,
          error:
            e instanceof z.ZodError
              ? { code: 'INVALID_ARGUMENT', message: 'Invalid tool arguments.' }
              : publicError(e),
        }),
      );
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.socket, resolve);
  });
  await chmod(cfg.socket, 0o600);
  let web: Awaited<ReturnType<typeof startWeb>>;
  let tunnel: Awaited<ReturnType<typeof startCloudflareTunnel>> | undefined;
  let timer: NodeJS.Timeout | undefined;
  const controller = new AbortController();
  let stopping = false;
  const stop = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    controller.abort();
    await tunnel?.close();
    await web?.close();
    server.close();
    await manager.shutdown();
    await audit.close();
    await lock.close();
    await unlink(cfg.socket).catch(() => {});
    await unlink(`${cfg.socket}.lock`).catch(() => {});
    process.exit(code);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
  try {
    if (cfg.quickTunnel || cfg.cfTunnelToken) {
      tunnel = await startCloudflareTunnel(cfg, controller.signal);
      cfg.baseUrl = tunnel.url;
      void tunnel.exited.then(() => {
        if (!stopping) {
          process.stderr.write('Cloudflare Tunnel stopped; shutting down for a clean restart.\n');
          void stop(1);
        }
      });
    }
    web = await startWeb(manager, cfg, dispatch);
    if (tunnel)
      process.stderr.write(
        `Public HTTPS URL: ${cfg.baseUrl}\nMCP URL: ${cfg.baseUrl}/mcp\n${cfg.quickTunnel ? 'Quick Tunnel URLs change on restart.' : 'Named tunnel uses the configured stable hostname.'}\n`,
      );
  } catch (error) {
    if (!stopping) {
      process.stderr.write(`${error instanceof Error ? error.message : 'Web startup failed'}\n`);
      await stop(1);
    }
    return;
  }
  timer = setInterval(() => {
    void manager.sweep().catch(() => process.stderr.write('Resource cleanup failed\n'));
  }, 15000);
  timer.unref();
  process.stderr.write('Browser MCP manager ready\n');
}
