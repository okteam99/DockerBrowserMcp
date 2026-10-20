import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { definitions } from './tools.js';
import { daemon } from './daemon.js';
import { config } from './config.js';
import { publicError } from './errors.js';

export function rpc(
  owner: string,
  name: string,
  args: unknown,
  operation_id = randomUUID(),
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
async function stdio() {
  const owner = process.env.MCP_PRINCIPAL ?? 'default';
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(owner)) throw new Error('Invalid MCP_PRINCIPAL');
  const server = new McpServer({ name: 'docker-browser-mcp', version: '0.1.0' });
  for (const [name, d] of Object.entries(definitions)) {
    // SDK accepts ZodEffects; raw shape would discard cross-field validation.
    server.registerTool(
      name,
      {
        description: d.description,
        inputSchema: d.schema as any,
        annotations: {
          readOnlyHint: !!d.readOnly,
          destructiveHint: !d.readOnly,
          openWorldHint: true,
        },
      },
      async (args: any): Promise<CallToolResult> => {
        const operationId = randomUUID();
        try {
          const result = await rpc(owner, name, d.schema.parse(args), operationId);
          const content: any[] = [{ type: 'text', text: JSON.stringify(result) }];
          if (
            name === 'get_artifact' &&
            result.data?.mime === 'image/png' &&
            result.data.offset === 0 &&
            result.data.complete &&
            Buffer.from(result.data.data_base64, 'base64')
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          )
            content.push({ type: 'image', mimeType: 'image/png', data: result.data.data_base64 });
          return { content, structuredContent: result, isError: result.status !== 'succeeded' };
        } catch (e) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  operation_id: operationId,
                  status: 'unknown',
                  error: publicError(e),
                  note: 'Use get_operation with operation_id before retrying.',
                }),
              },
            ],
            isError: true,
          };
        }
      },
    );
  }
  await server.connect(new StdioServerTransport());
}
const mode = process.argv[2] ?? 'stdio';
if (mode === 'daemon') await daemon();
else if (mode === 'stdio') await stdio();
else if (mode === 'health') {
  try {
    const result = await rpc('health', 'health', {});
    if (result.status !== 'succeeded') process.exitCode = 1;
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch {
    process.exitCode = 1;
  }
} else {
  process.stderr.write('Usage: node dist/cli.js daemon|stdio|health\n');
  process.exitCode = 1;
}
