import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Locator,
  type ElementHandle,
  type Dialog,
  type Download,
} from 'playwright';
import type { Server } from 'proxy-chain';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createSchema,
  loadProxies,
  proxySchema,
  type Config,
  type InstanceOptions,
  type Proxy,
} from './config.js';
import { NetworkPolicy, createGateway } from './network.js';
import { Artifacts } from './artifacts.js';
import { RecordingStore } from './recordings.js';
import { ToolError, publicError, safeUrl } from './errors.js';

type PageEntry = {
  page: Page;
  generation: number;
  refs: Map<string, ElementHandle>;
  dialog?: Dialog;
};
type Instance = {
  id: string;
  owner: string;
  browser: Browser;
  context: BrowserContext;
  gateway: Server;
  options: InstanceOptions;
  proxy?: Proxy;
  pages: Map<string, PageEntry>;
  created: number;
  touched: number;
  events: any[];
  downloads: any[];
  dir: string;
  busy: boolean;
  closing: boolean;
  crashed: boolean;
  activePageId?: string;
};
export type Target = {
  ref?: string;
  role?: string;
  name?: string;
  text?: string;
  css?: string;
  frame?: string;
};

export class BrowserManager {
  instances = new Map<string, Instance>();
  artifacts: Artifacts;
  policy: NetworkPolicy;
  recordings: RecordingStore;
  private creating = 0;
  constructor(public cfg: Config) {
    this.artifacts = new Artifacts(cfg);
    this.policy = new NetworkPolicy(cfg);
    this.recordings = new RecordingStore(cfg);
  }
  async init() {
    await mkdir(this.cfg.dataDir, { recursive: true, mode: 0o700 });
    await this.artifacts.init();
    await this.recordings.init();
    // The daemon holds its singleton lock before initialization. Remove orphaned download spools after restart.
    await rm(join(this.cfg.dataDir, 'sessions'), { recursive: true, force: true });
    await mkdir(join(this.cfg.dataDir, 'sessions'), { recursive: true, mode: 0o700 });
  }
  private instance(owner: string, id: string) {
    const i = this.instances.get(id);
    if (!i || i.owner !== owner || i.closing)
      throw new ToolError('INSTANCE_NOT_FOUND', 'Unknown or closed instance.');
    if (i.crashed)
      throw new ToolError(
        'BROWSER_CLOSED',
        'Browser crashed or disconnected; close and recreate instance.',
      );
    i.touched = Date.now();
    return i;
  }
  private page(i: Instance, id: string) {
    const p = i.pages.get(id);
    if (!p || p.page.isClosed()) throw new ToolError('PAGE_NOT_FOUND', 'Unknown or closed page.');
    return p;
  }
  private event(i: Instance, data: any) {
    i.events.push({ time: new Date().toISOString(), ...data });
    if (i.events.length > 300) i.events.shift();
  }
  private clearRefs(p: PageEntry) {
    for (const h of p.refs.values()) void h.dispose().catch(() => {});
    p.refs.clear();
  }
  private attach(i: Instance, page: Page) {
    const id = `page_${randomUUID()}`;
    if (i.pages.size >= this.cfg.maxPages) {
      void page.close();
      this.event(i, { type: 'page_limit' });
      return id;
    }
    const entry: PageEntry = { page, generation: 0, refs: new Map() };
    i.pages.set(id, entry);
    i.activePageId = id;
    page.on('close', () => {
      this.clearRefs(entry);
      i.pages.delete(id);
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        this.clearRefs(entry);
        this.event(i, { type: 'navigation', page_id: id, url: safeUrl(frame.url()) });
      }
    });
    page.on('requestfailed', (r) =>
      this.event(i, {
        type: 'request_failed',
        page_id: id,
        url: safeUrl(r.url()),
        error: r.failure()?.errorText,
      }),
    );
    page.on('response', (r) => {
      if (r.request().isNavigationRequest() || r.status() >= 400)
        this.event(i, { type: 'response', page_id: id, url: safeUrl(r.url()), status: r.status() });
    });
    // Page-supplied console strings can contain credentials; store category only.
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning')
        this.event(i, { type: 'console', level: msg.type(), page_id: id });
    });
    page.on('pageerror', () => this.event(i, { type: 'page_error', page_id: id }));
    page.on('dialog', (dialog) => {
      entry.dialog = dialog;
    });
    page.on('download', (download) => {
      void this.download(i, id, download);
    });
    page.on('crash', () => this.event(i, { type: 'page_crashed', page_id: id }));
    return id;
  }
  private async download(i: Instance, pageId: string, download: Download) {
    const item: any = {
      download_id: `dl_${randomUUID()}`,
      page_id: pageId,
      name: download.suggestedFilename(),
      status: 'in_progress',
    };
    i.downloads.push(item);
    const sizeWatch = setInterval(() => {
      void readdir(i.dir)
        .then(async (files) => {
          for (const f of files) {
            const size = (await stat(join(i.dir, f)).catch(() => null))?.size ?? 0;
            if (size > this.cfg.downloadLimit) {
              void download.cancel();
              break;
            }
          }
        })
        .catch(() => {});
    }, 250);
    sizeWatch.unref();
    const watchdog = setTimeout(() => {
      void download.cancel();
    }, 120000);
    watchdog.unref();
    try {
      const stream = await download.createReadStream();
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const part of stream) {
        total += part.length;
        if (total > this.cfg.downloadLimit) {
          await download.cancel();
          throw new ToolError('DOWNLOAD_TOO_LARGE', 'Download exceeds configured limit.');
        }
        chunks.push(Buffer.from(part));
      }
      if (await download.failure())
        throw new ToolError('DOWNLOAD_FAILED', 'Download did not complete.');
      const bytes = Buffer.concat(chunks);
      item.artifact = await this.artifacts.save(
        i.owner,
        i.id,
        item.name,
        'application/octet-stream',
        bytes,
        'download',
      );
      item.status = 'completed';
    } catch (e) {
      item.status = 'failed';
      item.error = publicError(e);
    } finally {
      clearInterval(sizeWatch);
      clearTimeout(watchdog);
      await download.delete().catch(() => {});
    }
  }
  private async resolveProxy(options: { proxy?: Proxy; proxy_ref?: string }) {
    if (options.proxy && options.proxy_ref)
      throw new ToolError('INVALID_ARGUMENT', 'proxy and proxy_ref are mutually exclusive.');
    if (options.proxy_ref) {
      const found = (await loadProxies(this.cfg.proxyFile))[options.proxy_ref];
      if (!found) throw new ToolError('PROXY_NOT_FOUND', 'Unknown proxy_ref.');
      return proxySchema.parse({
        server: found.server,
        username: found.username,
        password: found.password,
      });
    }
    return options.proxy ? proxySchema.parse(options.proxy) : undefined;
  }
  private summary(i: Instance) {
    return {
      instance_id: i.id,
      active_page_id: i.activePageId,
      recording_id: this.recordings.active.get(i.id)?.meta.id,
      live_frame_at: this.recordings.active.get(i.id)?.latest?.time,
      live_url: this.cfg.baseUrl
        ? `${this.cfg.baseUrl.replace(/\/$/, '')}/api/instances/${i.id}/live`
        : undefined,
      status: i.crashed ? 'crashed' : 'ready',
      created_at: new Date(i.created).toISOString(),
      viewport: i.options.viewport,
      user_agent: i.options.user_agent ?? 'browser default',
      locale: i.options.locale,
      timezone: i.options.timezone,
      mobile: i.options.mobile,
      proxy: i.proxy
        ? { server: i.proxy.server, authenticated: Boolean(i.proxy.username || i.proxy.password) }
        : null,
      idle_timeout_seconds: i.options.idle_timeout_seconds,
      max_lifetime_seconds: i.options.max_lifetime_seconds,
      pages: Array.from(i.pages, ([page_id, p]) => ({ page_id, url: p.page.url() })),
      warnings: [
        'UA/viewport simulation is not a real mobile device. Client Hints may differ; verify on the target.',
        'Host policy is defense in depth; use trusted upstream proxies and a network firewall for strict egress isolation.',
      ],
    };
  }
  async create(owner: string, raw: unknown) {
    if (this.instances.size + this.creating >= this.cfg.maxInstances)
      throw new ToolError('INSTANCE_LIMIT', 'Maximum instances reached.');
    this.creating++;
    let gateway: Server | undefined, browser: Browser | undefined, dir: string | undefined;
    try {
      const options = createSchema.parse(raw);
      const proxy = await this.resolveProxy(options);
      gateway = await createGateway(this.policy, proxy);
      dir = await mkdtemp(join(this.cfg.dataDir, 'sessions', 'instance-'));
      browser = await chromium.launch({
        headless: true,
        chromiumSandbox: process.env.CHROMIUM_SANDBOX === 'true',
        timeout: 30000,
        downloadsPath: dir,
        proxy: { server: `http://127.0.0.1:${gateway.port}`, bypass: '<-loopback>' },
        args: [
          '--disable-quic',
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
          '--disable-background-networking',
          '--disable-features=DnsOverHttps',
        ],
      });
      const context = await browser.newContext({
        userAgent: options.user_agent,
        viewport: options.viewport,
        isMobile: options.mobile?.enabled ?? false,
        hasTouch: options.mobile?.touch ?? false,
        deviceScaleFactor: options.mobile?.device_scale_factor ?? 1,
        locale: options.locale,
        timezoneId: options.timezone,
        acceptDownloads: true,
        serviceWorkers: 'block',
      });
      context.setDefaultTimeout(this.cfg.timeout);
      context.setDefaultNavigationTimeout(this.cfg.timeout);
      // Reject local schemes and redirects before request execution; the gateway also validates each destination.
      await context.route('**/*', async (route) => {
        try {
          await this.policy.url(route.request().url());
          await route.continue();
        } catch {
          await route.abort('blockedbyclient');
        }
      });
      const i: Instance = {
        id: `ins_${randomUUID()}`,
        owner,
        browser,
        context,
        gateway,
        options,
        proxy,
        pages: new Map(),
        created: Date.now(),
        touched: Date.now(),
        events: [],
        downloads: [],
        dir,
        busy: false,
        closing: false,
        crashed: false,
      };
      context.on('page', (page) => this.attach(i, page));
      browser.on('disconnected', () => {
        i.crashed = true;
      });
      this.instances.set(i.id, i);
      const p = await context.newPage();
      await this.recordings.start(i.id, owner, () => {
        const e = i.pages.get(i.activePageId ?? '') ?? Array.from(i.pages.values()).at(-1);
        if (!e) return undefined;
        return {
          page: e.page,
          page_id: Array.from(i.pages).find(([, v]) => v === e)![0],
          deviceScaleFactor: i.options.mobile?.device_scale_factor ?? 1,
          busy: i.busy,
        };
      });
      return { ...this.summary(i), actual: await this.environment(p) };
    } catch (e) {
      if (browser) {
        for (const [id, i] of this.instances) if (i.browser === browser) this.instances.delete(id);
      }
      if (browser) {
        for (const [id, r] of this.recordings.active)
          if (!this.instances.has(id)) await this.recordings.stop(id).catch(() => {});
      }
      await browser?.close().catch(() => {});
      await gateway?.close(true).catch(() => {});
      if (dir) await rm(dir, { recursive: true, force: true });
      throw e;
    } finally {
      this.creating--;
    }
  }
  private async environment(p: Page) {
    return {
      viewport: p.viewportSize(),
      ...(await p.evaluate(() => ({
        user_agent: navigator.userAgent,
        layout_viewport: { width: innerWidth, height: innerHeight },
        screen: { width: screen.width, height: screen.height },
        device_scale_factor: devicePixelRatio,
        touch_points: navigator.maxTouchPoints,
        language: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        client_hints: (navigator as any).userAgentData?.toJSON() ?? null,
      }))),
    };
  }
  private async withDialog(p: PageEntry, action: () => Promise<unknown>) {
    let listener: (d: Dialog) => void = () => {};
    const dialog = new Promise<{ type: string; message: string }>((resolve) => {
      listener = (d) => resolve({ type: d.type(), message: d.message().slice(0, 1000) });
      p.page.once('dialog', listener);
    });
    try {
      return await Promise.race([action().then(() => null), dialog]);
    } finally {
      p.page.off('dialog', listener);
    }
  }
  private target(p: PageEntry, target: Target): Locator | ElementHandle {
    if (target.ref) {
      const ref = p.refs.get(target.ref);
      if (!ref)
        throw new ToolError(
          'STALE_ELEMENT_REFERENCE',
          'Get a new snapshot before using this reference.',
        );
      return ref;
    }
    const root = target.frame ? p.page.frameLocator(target.frame) : p.page;
    if (target.role) return root.getByRole(target.role as any, { name: target.name, exact: true });
    if (target.text !== undefined) return root.getByText(target.text, { exact: true });
    if (target.css) return root.locator(target.css);
    throw new ToolError('INVALID_TARGET', 'Specify ref, role, text, or css.');
  }
  async close(owner: string, id: string) {
    const i = this.instances.get(id);
    if (!i || i.owner !== owner) throw new ToolError('INSTANCE_NOT_FOUND', 'Unknown instance.');
    i.closing = true;
    this.instances.delete(id);
    await this.recordings.stop(i.id).catch(() => {});
    await i.context.close().catch(() => {});
    await i.browser.close().catch(() => {});
    await i.gateway.close(true).catch(() => {});
    await rm(i.dir, { recursive: true, force: true });
    return { instance_id: id, status: 'closed' };
  }
  async sweep() {
    for (const i of this.instances.values())
      if (
        !i.busy &&
        (i.crashed ||
          Date.now() - i.touched > i.options.idle_timeout_seconds * 1000 ||
          Date.now() - i.created > i.options.max_lifetime_seconds * 1000)
      )
        await this.close(i.owner, i.id);
    await this.artifacts.clean();
    await this.recordings.clean();
  }
  adminInstances() {
    return Array.from(this.instances.values(), (i) => ({ ...this.summary(i), owner: i.owner }));
  }
  async shutdown() {
    await Promise.allSettled(Array.from(this.instances.values(), (i) => this.close(i.owner, i.id)));
  }
  async execute(owner: string, name: string, a: any): Promise<any> {
    if (name === 'list_recordings')
      return (await this.recordings.list())
        .filter((r) => r.owner === owner && (!a.instance_id || r.instance_id === a.instance_id))
        .map((r) => ({
          ...r,
          playback_url: this.cfg.baseUrl
            ? `${this.cfg.baseUrl.replace(/\/$/, '')}/api/recordings/${r.id}/video`
            : undefined,
        }));
    if (name === 'put_artifact') {
      const bytes = Buffer.from(a.data_base64, 'base64');
      if (bytes.length > 524288)
        throw new ToolError('ARTIFACT_TOO_LARGE', 'put_artifact limit is 512 KiB.');
      return this.artifacts.save(owner, 'upload', a.name, a.mime, bytes, 'upload');
    }
    if (name === 'health')
      return {
        status: 'ok',
        version: '0.2.0',
        instances: this.instances.size,
        max_instances: this.cfg.maxInstances,
      };
    if (name === 'list_proxies')
      return Object.entries(await loadProxies(this.cfg.proxyFile)).map(([ref, p]) => ({
        proxy_ref: ref,
        server: (() => {
          const u = new URL(p.server);
          return `${u.protocol}//${u.host}`;
        })(),
        country: p.country,
        authenticated: Boolean(p.username || p.password),
      }));
    if (name === 'create_instance') return this.create(owner, a);
    if (name === 'list_instances')
      return Array.from(this.instances.values())
        .filter((i) => i.owner === owner)
        .map((i) => this.summary(i));
    if (name === 'get_artifact')
      return this.artifacts.get(owner, a.artifact_id, a.offset, a.length);
    if (name === 'check_proxy') {
      const result = await this.create(owner, { proxy: a.proxy, proxy_ref: a.proxy_ref });
      try {
        return await this.execute(owner, 'verify_environment', {
          instance_id: result.instance_id,
          check_url: a.check_url,
        });
      } finally {
        await this.close(owner, result.instance_id);
      }
    }
    if (name === 'close_instance') return this.close(owner, a.instance_id);
    const i = this.instance(owner, a.instance_id);
    if (i.busy)
      throw new ToolError('INSTANCE_BUSY', 'An operation is already running on this instance.');
    i.busy = true;
    try {
      return await this.action(i, name, a);
    } finally {
      i.busy = false;
      i.touched = Date.now();
    }
  }
  private async action(i: Instance, name: string, a: any): Promise<any> {
    if (name === 'get_instance') return this.summary(i);
    if (name === 'list_pages')
      return Promise.all(
        Array.from(i.pages, async ([page_id, p]) => ({
          page_id,
          url: p.page.url(),
          title: await p.page.title().catch(() => ''),
          dialog: p.dialog?.type(),
        })),
      );
    if (name === 'create_page') {
      if (i.pages.size >= this.cfg.maxPages)
        throw new ToolError('PAGE_LIMIT', 'Maximum pages reached.');
      if (a.url) await this.policy.url(a.url);
      const p = await i.context.newPage();
      const page_id = Array.from(i.pages).find(([, e]) => e.page === p)![0];
      if (a.url) await p.goto(a.url, { waitUntil: 'domcontentloaded' });
      return { page_id, url: p.url() };
    }
    if (name === 'get_diagnostics')
      return { events: i.events.slice(-a.limit), downloads: i.downloads };
    if (name === 'list_downloads') return i.downloads;
    if (name === 'verify_environment') {
      const u = a.check_url ?? 'https://api.ipify.org?format=json';
      await this.policy.url(u);
      if (i.pages.size >= this.cfg.maxPages)
        throw new ToolError('PAGE_LIMIT', 'Free a page before verifying environment.');
      const p = await i.context.newPage();
      try {
        const response = await p.goto(u, { waitUntil: 'domcontentloaded' });
        const content = (await p.locator('body').innerText()).slice(0, 16384);
        if (!response || response.status() >= 400)
          throw new ToolError('ENVIRONMENT_CHECK_FAILED', 'IP check endpoint returned an error.');
        let parsed: any;
        try {
          parsed = JSON.parse(content);
        } catch {
          parsed = null;
        }
        return {
          instance_id: i.id,
          check_url: u,
          status: response.status(),
          actual: await this.environment(p),
          observed_ip: parsed?.ip ?? null,
          response: content,
          country: null,
          note: 'Verify observed_ip and any country assertion using a trusted source; HTTP success alone is not a proxy verification.',
        };
      } finally {
        await p.close();
      }
    }
    const p = this.page(i, a.page_id);
    if (['navigate', 'interact', 'upload_file'].includes(name)) i.activePageId = a.page_id;
    if (name === 'close_page') {
      await p.page.close();
      return { status: 'closed' };
    }
    if (name === 'navigate') {
      let response;
      if (a.action === 'back') response = await p.page.goBack({ waitUntil: 'domcontentloaded' });
      else if (a.action === 'forward')
        response = await p.page.goForward({ waitUntil: 'domcontentloaded' });
      else if (a.action === 'reload')
        response = await p.page.reload({ waitUntil: 'domcontentloaded' });
      else {
        await this.policy.url(a.url);
        response = await p.page.goto(a.url, { waitUntil: 'domcontentloaded' });
      }
      return {
        page_id: a.page_id,
        url: p.page.url(),
        status: response?.status() ?? null,
        title: await p.page.title(),
      };
    }
    if (name === 'snapshot') {
      this.clearRefs(p);
      p.generation++;
      const root = a.frame ? p.page.frameLocator(a.frame).locator('body') : p.page.locator('body');
      const tree = await root.ariaSnapshot();
      const elements = root.locator(
        'a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]',
      );
      const found: any[] = [];
      for (let n = 0; n < Math.min(await elements.count(), a.limit); n++) {
        const loc = elements.nth(n);
        if (!(await loc.isVisible().catch(() => false))) continue;
        const ref = `g${p.generation}e${n}`;
        const handle = await loc.elementHandle();
        if (!handle) continue;
        p.refs.set(ref, handle);
        found.push({
          ref,
          ...(await loc.evaluate((el) => ({
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role'),
            text: (
              el.getAttribute('aria-label') ||
              el.textContent ||
              el.getAttribute('placeholder') ||
              ''
            )
              .trim()
              .slice(0, 200),
            href: el.getAttribute('href'),
            type: el.getAttribute('type'),
          }))),
        });
      }
      return {
        page_id: a.page_id,
        url: p.page.url(),
        title: await p.page.title(),
        actual: await this.environment(p.page),
        tree: tree.slice(0, 60000),
        elements: found,
        frames: p.page.frames().map((f) => ({ name: f.name(), url: f.url() })),
        note: 'References identify the original DOM node; obtain a fresh snapshot after DOM changes. Content and URLs can contain user data.',
      };
    }
    if (name === 'interact') {
      let pendingDialog: { type: string; message: string } | null = null;
      if (a.action === 'scroll') {
        if (a.target) await this.target(p, a.target).scrollIntoViewIfNeeded();
        await p.page.mouse.wheel(a.delta_x ?? 0, a.delta_y ?? 600);
      } else {
        const loc = this.target(p, a.target);
        pendingDialog = await this.withDialog(p, async () => {
          if (a.action === 'click') await loc.click();
          else if (a.action === 'fill') await loc.fill(a.value ?? '');
          else if (a.action === 'press') await loc.press(a.value);
          else if (a.action === 'select') await loc.selectOption(a.value);
          else if (a.action === 'check') await loc.setChecked(a.checked ?? true);
          else if (a.action === 'hover') await loc.hover();
        });
      }
      this.clearRefs(p);
      return {
        url: p.page.url(),
        pending_dialog: pendingDialog,
        pages: Array.from(i.pages, ([page_id, e]) => ({ page_id, url: e.page.url() })),
      };
    }
    if (name === 'wait_for') {
      const timeout = Math.min(a.timeout_ms ?? this.cfg.timeout, 60000);
      if (a.target) {
        const loc = this.target(p, a.target);
        const state = a.state ?? 'visible';
        if ('waitFor' in loc) await loc.waitFor({ state, timeout });
        else if (state === 'attached') {
          if (!(await loc.evaluate((el) => el.isConnected)))
            throw new ToolError('STALE_ELEMENT_REFERENCE', 'Referenced node is detached.');
        } else if (state === 'detached') {
          const end = Date.now() + timeout;
          while (await loc.evaluate((el) => el.isConnected)) {
            if (Date.now() > end) throw new ToolError('TIMEOUT', 'Element remains attached.');
            await new Promise((r) => setTimeout(r, 100));
          }
        } else await loc.waitForElementState(state, { timeout });
      } else if (a.url) await p.page.waitForURL(a.url, { timeout, waitUntil: 'domcontentloaded' });
      else if (a.download_id) {
        const until = Date.now() + timeout;
        while (Date.now() < until) {
          const item = i.downloads.find((x) => x.download_id === a.download_id);
          if (!item) throw new ToolError('DOWNLOAD_NOT_FOUND', 'Unknown download.');
          if (item.status !== 'in_progress') return item;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new ToolError('TIMEOUT', 'Download is still in progress.');
      } else throw new ToolError('INVALID_ARGUMENT', 'Specify target, url, or download_id.');
      return { url: p.page.url() };
    }
    if (name === 'handle_dialog') {
      if (!p.dialog) throw new ToolError('DIALOG_NOT_FOUND', 'No pending dialog.');
      const d = p.dialog;
      p.dialog = undefined;
      if (a.accept) await d.accept(a.text);
      else await d.dismiss();
      return { type: d.type(), accepted: a.accept };
    }
    if (name === 'screenshot') {
      const bytes = await p.page.screenshot({
        type: 'png',
        fullPage: a.full_page ?? false,
        timeout: this.cfg.timeout,
      });
      return this.artifacts.save(i.owner, i.id, 'screenshot.png', 'image/png', bytes, 'screenshot');
    }
    if (name === 'upload_file') {
      const artifact = await this.artifacts.get(i.owner, a.artifact_id, 0, 0);
      // Read through the owner-checked artifact API in bounded chunks; no host filesystem path is accepted.
      const chunks: Buffer[] = [];
      for (let offset = 0; offset < artifact.size; offset += 262144)
        chunks.push(
          Buffer.from(
            (await this.artifacts.get(i.owner, a.artifact_id, offset, 262144)).data_base64,
            'base64',
          ),
        );
      await this.target(p, a.target).setInputFiles({
        name: artifact.name,
        mimeType: artifact.mime,
        buffer: Buffer.concat(chunks),
      });
      return { uploaded: true, artifact_id: a.artifact_id };
    }
    throw new ToolError('UNKNOWN_TOOL', 'Unknown tool.');
  }
}
