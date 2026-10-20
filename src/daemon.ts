import http from 'node:http';
import { mkdir, chmod, unlink, open, readFile, stat, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BrowserManager } from './browser.js';
import { definitions } from './tools.js';
import { config } from './config.js';
import { publicError, ToolError } from './errors.js';

export async function daemon() {
  process.umask(0o077);
  const cfg = config();
  const manager = new BrowserManager(cfg);
  await mkdir(dirname(cfg.socket), { recursive: true });
  // Recover only a lock whose process is dead (or is this PID after container restart).
  try {
    const pid = Number(await readFile(`${cfg.socket}.lock`, 'utf8'));
    if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid lock; inspect before removal');
    let alive = pid !== process.pid;
    if (alive) {
      try {
        process.kill(pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
        else throw e;
      }
    }
    if (alive) throw new Error('Another manager owns this socket');
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
  const audit = await open(`${cfg.dataDir}/audit.jsonl`, 'a', 0o600);
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health' && req.method === 'GET') {
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    try {
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
          owner: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
          name: z.string(),
          args: z.record(z.unknown()),
          operation_id: z.string().uuid(),
        })
        .parse(JSON.parse(raw));
      if (call.name === 'list_operations') {
        const a = definitions.list_operations.schema.parse(call.args);
        const data = Array.from(operations, ([operation_id, op]) => ({
          operation_id,
          owner: op.owner,
          tool: op.name,
          created_at: op.created_at,
          status: op.result?.status ?? 'running',
        }))
          .filter((op) => op.owner === call.owner)
          .slice(-a.limit);
        res.end(
          JSON.stringify({
            operation_id: call.operation_id,
            status: 'succeeded',
            data,
            error: null,
          }),
        );
        return;
      }
      if (call.name === 'get_operation') {
        const op = operations.get(String(call.args.operation_id));
        if (!op || op.owner !== call.owner)
          throw new ToolError(
            'OPERATION_NOT_FOUND',
            'Operation expired or does not belong to this principal.',
          );
        res.end(
          JSON.stringify({
            operation_id: call.operation_id,
            status: 'succeeded',
            data: op.result ?? { operation_id: call.args.operation_id, status: 'running' },
            error: null,
          }),
        );
        return;
      }
      const existing = operations.get(call.operation_id);
      if (existing && existing.owner !== call.owner)
        throw new ToolError('OPERATION_NOT_FOUND', 'Unknown operation.');
      let promise = existing?.promise;
      if (!promise) {
        const definition = definitions[call.name];
        if (!definition) throw new ToolError('UNKNOWN_TOOL', 'Unknown tool.');
        const args = definition.schema.parse(call.args);
        promise = (async () => {
          const started = Date.now();
          let result;
          try {
            result = {
              operation_id: call.operation_id,
              status: 'succeeded',
              data: await manager.execute(call.owner, call.name, args),
              error: null,
            };
          } catch (e) {
            result = {
              operation_id: call.operation_id,
              status: 'failed',
              data: null,
              error:
                e instanceof z.ZodError
                  ? { code: 'INVALID_ARGUMENT', message: 'Invalid arguments.' }
                  : publicError(e),
            };
          }
          const op = operations.get(call.operation_id);
          if (op) op.result = result;
          // Never let audit I/O turn a completed business action into a reported failure.
          try {
            // Never record arguments, URLs, page strings or credentials in audit.
            if ((await stat(auditPath)).size < 5242880)
              await audit.appendFile(
                JSON.stringify({
                  time: new Date().toISOString(),
                  owner: call.owner,
                  tool: call.name,
                  operation_id: call.operation_id,
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
        operations.set(call.operation_id, {
          owner: call.owner,
          name: call.name,
          created_at: new Date().toISOString(),
          promise,
        });
        order.push(call.operation_id);
        if (order.length > 500) operations.delete(order.shift()!);
      }
      res.end(JSON.stringify(await promise));
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
  const timer = setInterval(() => {
    void manager.sweep().catch(() => process.stderr.write('Resource cleanup failed\n'));
  }, 15000);
  timer.unref();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    server.close();
    await manager.shutdown();
    await audit.close();
    await lock.close();
    await unlink(cfg.socket).catch(() => {});
    await unlink(`${cfg.socket}.lock`).catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
  process.stderr.write('Browser MCP manager ready (Unix socket only)\n');
}
