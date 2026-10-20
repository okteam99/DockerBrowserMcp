import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFile } from 'node:fs/promises';
const client = new Client({ name: 'schema-export', version: '1.0.0' });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: ['dist/cli.js', 'stdio'] }),
);
try {
  await writeFile('docs/mcp-tools.json', JSON.stringify(await client.listTools(), null, 2) + '\n');
} finally {
  await client.close();
}
