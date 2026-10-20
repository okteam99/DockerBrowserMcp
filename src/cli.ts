import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { daemon } from './daemon.js';
import { rpc } from './rpc.js';
import { createMcpServer } from './mcp.js';

async function stdio() {
  const owner = process.env.MCP_PRINCIPAL ?? 'default';
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(owner)) throw new Error('Invalid MCP_PRINCIPAL');
  const server = createMcpServer(owner, rpc);
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
