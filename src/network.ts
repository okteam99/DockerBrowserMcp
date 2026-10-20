import { lookup } from 'node:dns/promises';
import type dns from 'node:dns';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Server } from 'proxy-chain';
import type { Config, Proxy } from './config.js';
import { ToolError } from './errors.js';

export function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}
export class NetworkPolicy {
  constructor(private cfg: Pick<Config, 'allowPrivate' | 'allowedHosts'>) {}
  async host(hostname: string) {
    const host = hostname
      .replace(/^\[|\]$/g, '')
      .toLowerCase()
      .replace(/\.$/, '');
    if (
      this.cfg.allowedHosts.length &&
      !this.cfg.allowedHosts.some(
        (x) => host === x || (x.startsWith('*.') && host.endsWith(x.slice(1))),
      )
    )
      throw new ToolError('NETWORK_BLOCKED', 'Destination is outside ALLOWED_HOSTS.');
    if (this.cfg.allowPrivate) return;
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local'))
      throw new ToolError('NETWORK_BLOCKED', 'Private destinations are disabled.');
    const ips = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    if (!ips.length || ips.some((x) => !isPublicAddress(x.address)))
      throw new ToolError('NETWORK_BLOCKED', 'Private or reserved destination is disabled.');
  }
  async url(raw: string) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new ToolError('INVALID_URL', 'An absolute HTTP(S) URL is required.');
    }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
      throw new ToolError(
        'INVALID_URL',
        'Only HTTP(S) URLs without embedded credentials are allowed.',
      );
    await this.host(u.hostname);
    return u;
  }
  lookup = ((hostname: string, options: any, callback: any) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    // Validate and select from the same DNS answer to avoid a second direct lookup.
    lookup(hostname, { all: true })
      .then((records) => {
        if (!this.cfg.allowPrivate && records.some((x) => !isPublicAddress(x.address)))
          throw new ToolError('NETWORK_BLOCKED', 'Private DNS response blocked.');
        const selected = records.filter((x) => !options.family || x.family === options.family);
        if (!selected.length) throw new Error('No address');
        if (options.all) callback(null, selected);
        else callback(null, selected[0].address, selected[0].family);
      })
      .catch((e) => callback(e));
  }) as typeof dns.lookup;
}
export async function createGateway(policy: NetworkPolicy, proxy?: Proxy) {
  let upstream: string | undefined;
  if (proxy) {
    const url = new URL(proxy.server);
    if (proxy.username !== undefined) url.username = proxy.username;
    if (proxy.password !== undefined) url.password = proxy.password;
    upstream = url.toString();
  }
  const gateway = new Server({
    host: '127.0.0.1',
    port: 0,
    verbose: false,
    prepareRequestFunction: async ({ hostname, port }) => {
      if (port < 1 || port > 65535)
        throw new ToolError('NETWORK_BLOCKED', 'Invalid destination port.');
      await policy.host(hostname);
      return { upstreamProxyUrl: upstream, dnsLookup: policy.lookup };
    },
  });
  gateway.on('requestFailed', () => {}); // Never log upstream credentials or request URLs.
  await gateway.listen();
  return gateway;
}
