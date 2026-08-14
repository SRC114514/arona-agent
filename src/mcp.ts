import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { config, type McpServerConfig } from "./config.ts";

interface McpConnection {
  client: Client;
  name: string;
  tools: Array<{ name: string; description: string; inputSchema: any }>;
}

const connections: McpConnection[] = [];

export async function connectMcpServers(): Promise<ToolDefinition[]> {
  // 重连前先断开并清空旧连接：/new 重开会话（initAgent → connectMcpServers）会再次
  // 执行本函数，若不清空模块级 connections，旧连接与子进程会重复累积并泄漏。
  await disconnectAllMcp();

  const allToolWrappers: ToolDefinition[] = [];

  for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
    try {
      const conn = await connectServer(serverName, serverConfig);
      connections.push(conn);

      for (const tool of conn.tools) {
        const wrapper = createToolWrapper(serverName, conn.client, tool);
        allToolWrappers.push(wrapper);
      }

      console.log(`[MCP] Connected to "${serverName}" with ${conn.tools.length} tools`);
    } catch (err) {
      console.warn(`[MCP] Failed to connect to "${serverName}": ${err instanceof Error ? err.message : err}`);
    }
  }

  return allToolWrappers;
}

async function connectServer(name: string, serverConfig: McpServerConfig): Promise<McpConnection> {
  const client = new Client(
    { name: "arona-agent", version: "1.0.0" },
    { capabilities: {} },
  );

  if (serverConfig.command) {
    const transport = new StdioClientTransport({
      command: serverConfig.command,
      args: serverConfig.args || [],
      env: { ...process.env, ...serverConfig.env } as Record<string, string>,
    });
    await client.connect(transport);
  } else if (serverConfig.url) {
    // Streamable HTTP（HTTP/SSE）型 server。SDK 1.30.0 无顶层 headers 选项，
    // 自定义 header 走 requestInit；不接 OAuth（authProvider），401 由调用方报错。
    const transport = new StreamableHTTPClientTransport(new URL(serverConfig.url), {
      requestInit: serverConfig.headers ? { headers: serverConfig.headers } : undefined,
    });
    await client.connect(transport);
  } else {
    throw new Error(`Server "${name}" has no command or url configured`);
  }

  const toolsResult = await client.listTools();
  return {
    client,
    name,
    tools: toolsResult.tools.map((t) => ({
      name: t.name,
      description: t.description || "",
      inputSchema: t.inputSchema,
    })),
  };
}

type McpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * 把 MCP callTool 的返回内容统一转成 SDK tool result 的 content blocks：
 * - text part 原样透传；
 * - image part（MCP 结构 {type:"image", data, mimeType} 与 SDK 的 ImageContent 一致）直通为 image block；
 * - 其他 part（resource/audio 等）与 structuredContent 用 JSON 兜底为文本，不静默丢弃。
 */
function collectMcpContent(result: any): McpContentBlock[] {
  const blocks: McpContentBlock[] = [];
  const textParts: string[] = [];

  const flushText = () => {
    if (textParts.length > 0) {
      blocks.push({ type: "text", text: textParts.join("\n") });
      textParts.length = 0;
    }
  };

  if (result.content && Array.isArray(result.content)) {
    for (const part of result.content as any[]) {
      if (part?.type === "text") {
        textParts.push(String(part.text ?? ""));
      } else if (part?.type === "image" && typeof part.data === "string") {
        // 先 flush 已积累的文本，保持输出顺序
        flushText();
        blocks.push({ type: "image", data: part.data, mimeType: part.mimeType || "image/png" });
      } else if (part) {
        try {
          textParts.push(`[part:${part.type || "unknown"}] ${JSON.stringify(part)}`);
        } catch {
          textParts.push(`[part:${part.type || "unknown"}] (unserializable)`);
        }
      }
    }
  }
  if (result.structuredContent !== undefined) {
    try {
      textParts.push(`[structuredContent] ${JSON.stringify(result.structuredContent)}`);
    } catch {
      textParts.push("[structuredContent] (unserializable)");
    }
  }
  flushText();
  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "(empty result)" });
  }
  return blocks;
}

function createToolWrapper(
  serverName: string,
  client: Client,
  tool: { name: string; description: string; inputSchema: any },
): ToolDefinition {
  // Build TypeBox schema from the MCP tool's JSON schema
  // For simplicity, use a permissive object schema that accepts any properties
  const parameters = Type.Object(
    {},
    { additionalProperties: true, description: tool.description },
  );

  return defineTool({
    name: `mcp_${serverName}_${tool.name}`,
    label: `${serverName}/${tool.name}`,
    description: `[MCP:${serverName}] ${tool.description}`,
    parameters,
    execute: async (_toolCallId, params) => {
      try {
        const result = await client.callTool({
          name: tool.name,
          arguments: params as Record<string, unknown>,
        });

        return {
          content: collectMcpContent(result),
          details: { server: serverName, tool: tool.name },
        };
      } catch (err) {
        throw new Error(`MCP tool ${serverName}/${tool.name} failed: ${err instanceof Error ? err.message : err}`);
      }
    },
  });
}

export function listMcpServers(): Array<{ name: string; tools: string[] }> {
  return connections.map((c) => ({
    name: c.name,
    tools: c.tools.map((t) => t.name),
  }));
}

export async function callMcpTool(serverName: string, toolName: string, args: Record<string, any>): Promise<string> {
  const conn = connections.find((c) => c.name === serverName);
  if (!conn) throw new Error(`MCP server "${serverName}" not connected`);
  if (!conn.tools.find((t) => t.name === toolName)) throw new Error(`Tool "${toolName}" not found on server "${serverName}"`);

  const result = await conn.client.callTool({ name: toolName, arguments: args });
  return collectMcpContent(result)
    .map((b) => (b.type === "text" ? b.text : `[image: ${b.mimeType}]`))
    .join("\n") || "(empty result)";
}

export async function disconnectAllMcp(): Promise<void> {
  for (const conn of connections) {
    try {
      await conn.client.close();
    } catch {
      // Ignore
    }
  }
  connections.length = 0;
}
