import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
export function rpc(
  owner: string,
  name: string,
  args: unknown,
  operation_id: string = randomUUID(),
): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: config().socket,
        path: '/call',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error('Invalid manager reply'));
          }
        });
      },
    );
    req.setTimeout(180000, () =>
      req.destroy(
        new Error(
          'Manager request timed out; operation may still be running. Inspect state before retry.',
        ),
      ),
    );
    req.on('error', reject);
    req.end(JSON.stringify({ owner, name, args, operation_id }));
  });
}
