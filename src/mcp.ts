import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { createServer } from "http";
import { z } from "zod";

// ─── Types (mirrored from src/index.ts) ────────────────────────────────────

type ExecutionEvent =
  | { type: "state"; path: string; from: unknown; to: unknown }
  | { type: "effect"; path: string; args: unknown[]; result: unknown }
  | { type: "child"; node: ExecutionNode };

type ExecutionNode = {
  id: number;
  actionPath: string;
  payload: unknown;
  events: ExecutionEvent[];
};

// ─── Log rendering (ported from src/index.ts) ──────────────────────────────

function safeStringify(value: unknown): string {
  if (typeof value === "object" && value !== null && "then" in value) return "[Promise]";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function renderExecutionTree(node: ExecutionNode, prefix: string, indent: string): string[] {
  const payloadStr = node.payload !== undefined ? ` (${JSON.stringify(node.payload)})` : "";
  const lines: string[] = [`${prefix}[${node.id}] ${node.actionPath}${payloadStr}`];

  node.events.forEach((event, i) => {
    const last = i === node.events.length - 1;
    const branch = indent + (last ? "└─ " : "├─ ");
    const nextIndent = indent + (last ? "   " : "│  ");

    if (event.type === "state") {
      lines.push(`${branch}state.${event.path}: ${safeStringify(event.from)} → ${safeStringify(event.to)}`);
    } else if (event.type === "effect") {
      const args = event.args.map((a) => safeStringify(a)).join(", ");
      const result = event.result !== undefined ? ` → ${safeStringify(event.result)}` : "";
      lines.push(`${branch}effects.${event.path}(${args})${result}`);
    } else {
      lines.push(...renderExecutionTree(event.node, branch, nextIndent));
    }
  });

  return lines;
}

// ─── Start ──────────────────────────────────────────────────────────────────

export async function startServer() {
  const PORT = 7777;

  type LogEntry = { timestamp: string; rendered: string; node: ExecutionNode };
  const logs: LogEntry[] = [];

  const connections = new Set<WebSocket>();
  const pendingActions = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

  const getSocket = (): WebSocket | null => {
    for (const ws of connections) {
      if (ws.readyState === 1 /* OPEN */) return ws;
    }
    return null;
  };

  // ─── WebSocket server ─────────────────────────────────────────────────────

  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws) => {
    console.error("[devtools-mcp] Browser connected");
    connections.add(ws);

    ws.on("message", (data) => {
      let msg: { type: string; id?: string; data?: unknown; result?: unknown; error?: string; payload?: unknown; success?: boolean };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (msg.type === "log") {
        const node = msg.data as ExecutionNode;
        logs.push({
          timestamp: new Date().toISOString(),
          rendered: renderExecutionTree(node, "", "").join("\n"),
          node,
        });
      } else if (msg.type === "state_result" && msg.id) {
        const pending = pendingActions.get(msg.id);
        if (pending) {
          if (msg.error) {
            pending.reject(new Error(msg.error));
          } else {
            pending.resolve(msg.data);
          }
          pendingActions.delete(msg.id);
        }
      } else if (msg.type === "set_state_result" && msg.id) {
        const pending = pendingActions.get(msg.id);
        if (pending) {
          if (msg.error) {
            pending.reject(new Error(msg.error));
          } else {
            pending.resolve(msg.success);
          }
          pendingActions.delete(msg.id);
        }
      } else if (msg.type === "action_result" && msg.id) {
        const pending = pendingActions.get(msg.id);
        if (pending) {
          if (msg.error) {
            pending.reject(new Error(msg.error));
          } else {
            pending.resolve(msg.result);
          }
          pendingActions.delete(msg.id);
        }
      }
    });

    ws.on("close", () => {
      console.error("[devtools-mcp] Browser disconnected");
      connections.delete(ws);
    });
  });

  httpServer.listen(PORT, () => {
    console.error(`[devtools-mcp] WebSocket server listening on ws://localhost:${PORT}`);
  });

  // ─── MCP server ───────────────────────────────────────────────────────────

  const server = new McpServer({
    name: "framework-devtools",
    version: "1.0.0",
  });

  server.tool(
    "get_logs",
    "Get framework action/state-change logs from the running app. Each entry shows the action that fired and every state/effect event it triggered, as a readable tree. Returns the most recent entries first.",
    {
      limit: z.number().optional().describe("Max number of log entries to return (default: 50)"),
    },
    async ({ limit = 50 }) => {
      if (!getSocket()) {
        return { content: [{ type: "text", text: "Error: No app connected. Start your app and make sure it connects to the devtools." }] };
      }
      const slice = logs.slice(-limit);
      if (slice.length === 0) {
        return { content: [{ type: "text", text: "No logs yet." }] };
      }
      const text = slice
        .map((entry) => `[${entry.timestamp}]\n${entry.rendered}`)
        .join("\n\n---\n\n");
      return { content: [{ type: "text", text }] };
    },
  );

  server.tool(
    "clear_logs",
    "Clear all buffered framework logs.",
    {},
    async () => {
      if (!getSocket()) {
        return { content: [{ type: "text", text: "Error: No app connected. Start your app and make sure it connects to the devtools." }] };
      }
      logs.length = 0;
      return { content: [{ type: "text", text: "Logs cleared." }] };
    },
  );

  server.tool(
    "get_state",
    "Get a snapshot of the current framework state from the running browser app. Returns all atom values as a JSON object, mirroring the shape of state.ts. asyncAtoms that haven't loaded yet appear as '[pending]'.",
    {},
    async () => {
      if (!getSocket()) {
        return { content: [{ type: "text", text: "Error: No app connected. Start your app and make sure it connects to the devtools." }] };
      }

      const id = Math.random().toString(36).slice(2);

      const result = await new Promise<unknown>((resolve, reject) => {
        pendingActions.set(id, { resolve, reject });
        getSocket()!.send(JSON.stringify({ type: "get_state", id }));
        setTimeout(() => {
          if (pendingActions.has(id)) {
            pendingActions.delete(id);
            reject(new Error("get_state timed out after 10s"));
          }
        }, 10_000);
      });

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "trigger_action",
    "Trigger a framework action in the running browser app. Use dot notation for namespaced actions. The action runs exactly as if the user triggered it.",
    {
      path: z.string().describe("Action path in dot notation, e.g. 'addTodo' or 'auth.login'"),
      payload: z.string().optional().describe("JSON-encoded payload, e.g. '\"my todo title\"' or '{\"id\":\"abc\"}'"),
    },
    async ({ path, payload }) => {
      if (!getSocket()) {
        return { content: [{ type: "text", text: "Error: No app connected. Start your app and make sure it connects to the devtools." }] };
      }

      const id = Math.random().toString(36).slice(2);
      const parsedPayload = payload !== undefined ? JSON.parse(payload) : undefined;

      const result = await new Promise<unknown>((resolve, reject) => {
        pendingActions.set(id, { resolve, reject });
        getSocket()!.send(JSON.stringify({ type: "trigger_action", id, path, payload: parsedPayload }));
        setTimeout(() => {
          if (pendingActions.has(id)) {
            pendingActions.delete(id);
            reject(new Error("Action timed out after 10s"));
          }
        }, 10_000);
      });

      const text =
        result !== null && result !== undefined
          ? JSON.stringify(result, null, 2)
          : "Action completed (no return value).";
      return { content: [{ type: "text", text }] };
    },
  );

  server.tool(
    "set_state",
    "Directly set an atom's value in the running browser app. Use dot notation for the path. Useful for debugging specific states without triggering action side-effects.",
    {
      path: z.string().describe("Atom path in dot notation, e.g. 'filter' or 'user.name'"),
      value: z.string().describe("JSON-encoded value to set, e.g. '\"completed\"' or 'true' or '[1,2,3]'"),
    },
    async ({ path, value }) => {
      if (!getSocket()) {
        return { content: [{ type: "text", text: "Error: No app connected. Start your app and make sure it connects to the devtools." }] };
      }

      const id = Math.random().toString(36).slice(2);
      const parsedValue = JSON.parse(value);

      await new Promise<unknown>((resolve, reject) => {
        pendingActions.set(id, { resolve, reject });
        getSocket()!.send(JSON.stringify({ type: "set_state", id, path, value: parsedValue }));
        setTimeout(() => {
          if (pendingActions.has(id)) {
            pendingActions.delete(id);
            reject(new Error("set_state timed out after 10s"));
          }
        }, 10_000);
      });

      return { content: [{ type: "text", text: `State "${path}" set to ${value}.` }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
