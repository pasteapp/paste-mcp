// Fallback MCP server served over stdio when Paste isn't reachable. Exposes
// a single tool whose only job is to tell the AI assistant (and the user) how
// to bring Paste online. We also set the server `instructions` so capable
// clients show the same hint without needing to call the tool.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

export const SETUP_MESSAGE =
  'Paste is not running, or MCP is disabled. Start Paste and enable MCP in ' +
  'Settings → MCP & AI Tools, then restart this AI app.';

export const PASTE_STATUS_TOOL = {
  name: 'paste_status',
  description:
    "Returns Paste's connection status. Call this if Paste-related tools are " +
    'missing — the response explains how to bring Paste online.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
} as const;

export function callPasteStatus(toolName: string): {
  content: { type: 'text'; text: string }[];
  isError: boolean;
} {
  if (toolName !== PASTE_STATUS_TOOL.name) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  return {
    content: [{ type: 'text', text: SETUP_MESSAGE }],
    isError: false,
  };
}

export function buildFallbackServer(): Server {
  const server = new Server(
    { name: 'paste-mcp', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions: SETUP_MESSAGE,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [PASTE_STATUS_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callPasteStatus(request.params.name),
  );

  return server;
}

export async function serveFallback(): Promise<void> {
  const server = buildFallbackServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
}
