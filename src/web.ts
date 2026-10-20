import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from './config.js';
import type { BrowserManager } from './browser.js';
import { WebAuth } from './auth.js';
import { createMcpServer, type Dispatch } from './mcp.js';
import { definitions } from './tools.js';
import { dashboard, loginPage, sharePage } from './web-ui.js';
import { publicError } from './errors.js';
import { liveMedia, videoMedia } from './media.js';

async function body(req: IncomingMessage, limit = 1048576) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Error('Body too large');
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks).toString('utf8');
}
const json = (res: ServerResponse, value: unknown, status = 200) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
};
const docsRoot = fileURLToPath(new URL('../', import.meta.url));
const documents: Record<string, string> = {
  'README.md': 'README.md',
  'mcp-api.md': 'docs/mcp-api.md',
  'mcp-tools.json': 'docs/mcp-tools.json',
  'agent-workflow.md': 'docs/agent-workflow.md',
};
export async function startWeb(manager: BrowserManager, cfg: Config, dispatch: Dispatch) {
  if (cfg.webPort === 0) return undefined;
  if (!cfg.webPassword || !cfg.baseUrl)
    throw Error(
      'BASE_URL and WEB_PASSWORD are required for web mode. Use WEB_PORT=0 for stdio-only mode.',
    );
  const base = new URL(cfg.baseUrl);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw Error('BASE_URL must be an absolute HTTP(S) URL without credentials, query or fragment.');
  const baseUrl = base.href.replace(/\/$/, '');
  cfg.baseUrl = baseUrl;
  const prefix = base.pathname.replace(/\/$/, '');
  const auth = new WebAuth();
  await auth.init(cfg.dataDir, cfg.webPassword);
  const streams = new Set<ServerResponse>();
  const server = http.createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; media-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    let requestUrl: URL;
    try {
      requestUrl = new URL(req.url ?? '/', base);
    } catch {
      json(res, { error: 'Invalid request URL' }, 400);
      return;
    }
    let path = requestUrl.pathname;
    if (prefix && path === prefix) path = '/';
    else if (prefix && path.startsWith(prefix + '/')) path = path.slice(prefix.length);
    const session = auth.cookie(req.headers.cookie);
    const bearer = auth.bearer(req.headers.authorization);
    const authorized = Boolean(session || bearer);
    try {
      if (req.headers.origin && req.headers.origin !== base.origin) {
        json(res, { error: 'Origin not allowed' }, 403);
        return;
      }
      if (path.startsWith('/assets/') && req.method === 'GET') {
        const files: Record<string, string> = {
          '/assets/app.js': 'application/javascript; charset=utf-8',
          '/assets/app.css': 'text/css; charset=utf-8',
        };
        const mime = Object.hasOwn(files, path) ? files[path] : undefined;
        if (!mime) {
          json(res, { error: 'Not found' }, 404);
          return;
        }
        const gzip = (req.headers['accept-encoding'] ?? '')
          .split(',')
          .some((part) => /^gzip(?:;q=(?!0(?:\.0*)?$)[\d.]+)?$/.test(part.trim()));
        const content = await readFile(
          fileURLToPath(new URL(`./public/${path.slice(8)}${gzip ? '.gz' : ''}`, import.meta.url)),
        );
        res.setHeader('vary', 'Accept-Encoding');
        if (gzip) res.setHeader('content-encoding', 'gzip');
        res.setHeader('content-type', mime);
        res.end(content);
        return;
      }
      if (path === '/healthz') {
        json(res, { status: 'ok', version: '0.4.0' });
        return;
      }
      if (path === '/mcp') {
        if (!bearer) {
          res.setHeader('www-authenticate', 'Bearer realm="DockerBrowserMcp"');
          json(res, { error: 'Bearer token required' }, 401);
          return;
        }
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST');
          json(res, { error: 'Use MCP Streamable HTTP POST' }, 405);
          return;
        }
        const parsed = JSON.parse(await body(req));
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        const mcp = createMcpServer('web', dispatch);
        await mcp.connect(transport);
        res.once('close', () => {
          void transport.close();
          void mcp.close();
        });
        await transport.handleRequest(req, res, parsed);
        return;
      }
      if (path === '/login' && req.method === 'POST') {
        const form = new URLSearchParams(await body(req, 8192));
        const pass = form.get('password') ?? '';
        if (pass.length > 1024) {
          json(res, { error: 'Invalid password' }, 400);
          return;
        }
        const result = auth.login(req.socket.remoteAddress ?? 'unknown', pass);
        if (result.session) {
          res.setHeader(
            'set-cookie',
            `browser_session=${result.session}; HttpOnly; SameSite=Strict; Path=${prefix || ''}/; Max-Age=86400${base.protocol === 'https:' ? '; Secure' : ''}`,
          );
          res.statusCode = 303;
          res.setHeader('location', `${prefix}/`);
          res.end();
        } else {
          res.statusCode = result.limited ? 429 : 401;
          res.setHeader('content-type', 'text/html; charset=utf-8');
          res.end(
            loginPage(prefix, result.limited ? '尝试过多，请在 10 分钟后重试。' : '密码不正确。'),
          );
        }
        return;
      }
      if (path === '/' && req.method === 'GET') {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(session ? dashboard(prefix, session) : loginPage(prefix));
        return;
      }
      const shared = /^\/share\/([A-Za-z0-9_-]{43})(?:\/(media|status))?$/.exec(path);
      if (shared && ['GET', 'HEAD'].includes(req.method ?? '')) {
        res.setHeader('referrer-policy', 'no-referrer');
        res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive');
        const grant = manager.shares.resolve(shared[1]);
        const allowed = () => Boolean(manager.shares.resolve(shared[1]));
        let state: 'live' | 'ready' | 'ended' | 'unavailable' = 'unavailable';
        if (grant?.kind === 'live') {
          const instance = manager.instances.get(grant.resource_id);
          state =
            instance &&
            instance.owner === grant.owner &&
            !instance.closing &&
            !instance.crashed &&
            manager.recordings.active.has(instance.id)
              ? 'live'
              : 'ended';
        } else if (grant) {
          const recording = await manager.recordings.get(grant.resource_id).catch(() => null);
          if (
            recording &&
            recording.meta.owner === grant.owner &&
            !['recording', 'finalizing'].includes(recording.meta.status) &&
            (await stat(recording.path).catch(() => null))?.size
          )
            state = 'ready';
        }
        if (!grant || !allowed()) {
          if (!shared[2]) {
            res.statusCode = 404;
            res.setHeader('content-type', 'text/html; charset=utf-8');
            res.end(req.method === 'HEAD' ? undefined : sharePage(prefix));
          } else json(res, { error: 'Share link unavailable' }, 404);
          return;
        }
        const view = {
          kind: grant.kind,
          state,
          expires_at: grant.expires_at,
          media_url: `${prefix}/share/${shared[1]}/media`,
          status_url: `${prefix}/share/${shared[1]}/status`,
        };
        if (shared[2] === 'status') json(res, view);
        else if (!shared[2]) {
          res.setHeader('content-type', 'text/html; charset=utf-8');
          res.end(req.method === 'HEAD' ? undefined : sharePage(prefix, view));
        } else if (!['live', 'ready'].includes(state))
          json(res, { error: state === 'ended' ? 'Live stream ended' : 'Media unavailable' }, 410);
        else if (grant.kind === 'live') {
          if (req.method !== 'GET') {
            res.statusCode = 405;
            res.setHeader('allow', 'GET');
            res.end();
          } else liveMedia(manager, cfg, res, streams, grant.resource_id, allowed);
        } else await videoMedia(manager, req, res, grant.resource_id, allowed);
        return;
      }
      if (!authorized) {
        json(res, { error: 'Authentication required' }, 401);
        return;
      }
      if (path === '/logout' && req.method === 'POST') {
        const form = new URLSearchParams(await body(req, 8192));
        if (!session || form.get('csrf') !== session) {
          json(res, { error: 'Invalid session' }, 403);
          return;
        }
        auth.logout(session);
        res.setHeader(
          'set-cookie',
          `browser_session=; HttpOnly; SameSite=Strict; Path=${prefix || ''}/; Max-Age=0${base.protocol === 'https:' ? '; Secure' : ''}`,
        );
        res.statusCode = 303;
        res.setHeader('location', `${prefix}/`);
        res.end();
        return;
      }
      if (path === '/api/connection' && req.method === 'GET') {
        const mcpUrl = `${baseUrl}/mcp`;
        const mcp_config = {
          mcpServers: {
            'docker-browser': {
              type: 'http',
              url: mcpUrl,
              headers: { Authorization: `Bearer ${auth.token}` },
            },
          },
        };
        const workflow = await readFile(`${docsRoot}docs/agent-workflow.md`, 'utf8');
        const api = await readFile(`${docsRoot}docs/mcp-api.md`, 'utf8');
        const agent_instructions = `# DockerBrowserMcp 远程浏览器接入\n\n服务: ${baseUrl}\nMCP: ${mcpUrl}\n传输: Streamable HTTP（非旧 SSE），支持的 MCP 客户端使用 HTTP POST。\n鉴权: Authorization: Bearer ${auth.token}\n\n此 Token 可控制浏览器及读取录屏，请仅在该服务使用。\n\n## MCP 配置\n\n${JSON.stringify(mcp_config, null, 2)}\n\n## 接入约定\n\n配置此 MCP 后先调用 health 和 tools/list。创建浏览器时可指定 user_agent、viewport、proxy（含 server、username、password）或 proxy_ref；默认最多 ${cfg.maxInstances} 个并发实例。\n实例直播与历史录像: ${baseUrl}/ （网页登录）。录屏可通过 list_recordings 查询，用相同 Bearer 鉴权获取 playback_url。用户需要公开观看时，调用 create_share_link 生成独立只读直播/录像链接；可设有效期，用 revoke_share_link 撤销。\n\nMCP Schema: ${baseUrl}/docs/mcp-tools.json （需相同 Authorization 头）\n完整使用文档: ${baseUrl}/docs/README.md\n\n${workflow}\n\n${api}`;
        json(res, {
          base_url: baseUrl,
          mcp_url: mcpUrl,
          mcp_config,
          agent_instructions,
          tool_count: Object.keys(definitions).length,
          max_instances: cfg.maxInstances,
        });
        return;
      }
      if (path.startsWith('/docs/') && req.method === 'GET') {
        const name = path.slice(6),
          file = documents[name];
        if (typeof file !== 'string') {
          json(res, { error: 'Not found' }, 404);
          return;
        }
        res.setHeader(
          'content-type',
          name.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
        );
        res.end(await readFile(`${docsRoot}${file}`));
        return;
      }
      if (path === '/api/instances' && req.method === 'GET') {
        json(res, { max_instances: cfg.maxInstances, instances: manager.adminInstances() });
        return;
      }
      if (path === '/api/recordings' && req.method === 'GET') {
        json(res, await manager.recordings.list());
        return;
      }
      const live = /^\/api\/instances\/(ins_[a-f0-9-]{36})\/live$/.exec(path);
      const allowed = () =>
        Boolean(auth.cookie(req.headers.cookie) || auth.bearer(req.headers.authorization));
      if (live && req.method === 'GET') {
        liveMedia(manager, cfg, res, streams, live[1], allowed);
        return;
      }
      const video = /^\/api\/recordings\/(rec_[a-f0-9-]{36})\/video$/.exec(path);
      if (video && ['GET', 'HEAD'].includes(req.method ?? '')) {
        await videoMedia(manager, req, res, video[1], allowed);
        return;
      }
      json(res, { error: 'Not found' }, 404);
    } catch (error) {
      if (!res.headersSent) json(res, { error: publicError(error) }, 500);
      else res.destroy();
    }
  });
  server.requestTimeout = 180000;
  server.headersTimeout = 15000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.webPort, '0.0.0.0', resolve);
  });
  process.stderr.write(
    `Web and MCP listening on port ${cfg.webPort}; public BASE_URL configured.\n`,
  );
  return {
    server,
    close: async () => {
      for (const r of streams) r.end();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
