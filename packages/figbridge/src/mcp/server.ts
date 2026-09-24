/**
 * MCP server over stdio. Tool errors are returned as `isError` results with an actionable
 * message instead of protocol errors, so the agent can recover (see docs/adr/0003).
 */

import { BridgeError } from "@figbridge/protocol";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { HubClient } from "../client.js";
import { VERSION } from "../version.js";
import { TOOLS, type ToolDefinition } from "./tools.js";

/** Build an MCP server exposing {@link TOOLS} over `client`. Exported for tests. */
export function createMcpServer(
  client: HubClient,
  tools: readonly ToolDefinition[] = TOOLS,
): McpServer {
  const server = new McpServer(
    { name: "figbridge", version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "figbridge reads and edits the Figma file open in Figma Desktop with the figbridge plugin running. " +
        "Start with figma_file_info or figma_outline; export nodes to look at them. " +
        "Changes are live for everyone viewing the file — confirm destructive edits with the user.",
    },
  );

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: tool.annotations,
      },
      async (args, ctx) => {
        const progressToken = ctx.mcpReq._meta?.progressToken;
        try {
          const content = await tool.invoke(args, {
            client,
            signal: ctx.mcpReq.signal,
            progress:
              progressToken === undefined
                ? undefined
                : (done, total) => {
                    void ctx.mcpReq.notify({
                      method: "notifications/progress",
                      params: {
                        progressToken,
                        progress: done,
                        ...(total === undefined ? {} : { total }),
                      },
                    });
                  },
          });
          return { content };
        } catch (thrown) {
          const error = BridgeError.from(thrown);
          return {
            isError: true,
            content: [
              { type: "text", text: `${error.code}: ${error.message}${describeData(error.data)}` },
            ],
          };
        }
      },
    );
  }
  return server;
}

/** Serve MCP on this process's stdin/stdout until the client disconnects. */
export function serveMcp(client: HubClient): { close(): Promise<void> } {
  return serveStdio(() => createMcpServer(client));
}

function describeData(data: unknown): string {
  if (data === undefined) return "";
  const text = JSON.stringify(data);
  return text.length > 2_000 ? `\n${text.slice(0, 2_000)}…` : `\n${text}`;
}
