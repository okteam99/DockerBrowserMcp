import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { definitions } from './tools.js';
import { publicError } from './errors.js';
export type Dispatch = (
  owner: string,
  name: string,
  args: any,
  operationId: string,
) => Promise<any>;
export function createMcpServer(owner: string, call: Dispatch) {
  const server = new McpServer({ name: 'docker-browser-mcp', version: '0.5.1' });
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
          const result = await call(owner, name, d.schema.parse(args), operationId);
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
  return server;
}
