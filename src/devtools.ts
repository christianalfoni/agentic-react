import type { ExecutionNode } from "./index";

const WS_URL = "ws://localhost:7777";

export function createDevtools() {
  const buffer: string[] = [];
  let ws: WebSocket | null = null;
  let appRef: { actions: Record<string, unknown>; setState: (path: string, value: unknown) => void } | null = null;
  let stateRef: Record<string, unknown> | null = null;

  function send(msg: unknown) {
    const data = JSON.stringify(msg);
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(data);
    } else {
      buffer.push(data);
    }
  }

  function onLog(node: ExecutionNode) {
    send({ type: "log", data: node });
  }

  function connect(app: { actions: Record<string, unknown>; setState: (path: string, value: unknown) => void }, state: Record<string, unknown>) {
    appRef = app;
    stateRef = state;
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      buffer.forEach((d) => ws!.send(d));
      buffer.length = 0;
    };

    ws.onmessage = (event) => {
      let msg: { type: string; id: string; path?: string; payload?: unknown; value?: unknown };
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type === "trigger_action") {
        try {
          const action = msg.path!
            .split(".")
            .reduce((obj: unknown, key: string) => (obj as Record<string, unknown>)?.[key], app.actions);

          if (typeof action !== "function") {
            ws!.send(JSON.stringify({ type: "action_result", id: msg.id, error: `Action not found: ${msg.path}` }));
            return;
          }

          Promise.resolve(action(msg.payload)).then(
            (result) => ws!.send(JSON.stringify({ type: "action_result", id: msg.id, result: result ?? null })),
            (err) => ws!.send(JSON.stringify({ type: "action_result", id: msg.id, error: String(err) })),
          );
        } catch (err) {
          ws!.send(JSON.stringify({ type: "action_result", id: msg.id, error: String(err) }));
        }
      }

      if (msg.type === "set_state") {
        try {
          app.setState(msg.path!, msg.value as unknown);
          ws!.send(JSON.stringify({ type: "set_state_result", id: msg.id, success: true }));
        } catch (err) {
          ws!.send(JSON.stringify({ type: "set_state_result", id: msg.id, error: String(err) }));
        }
      }

      if (msg.type === "get_state") {
        try {
          // Atoms define toJSON(), so JSON.stringify snapshots all current values
          const snapshot = JSON.parse(JSON.stringify(state));
          ws!.send(JSON.stringify({ type: "state_result", id: msg.id, data: snapshot }));
        } catch (err) {
          ws!.send(JSON.stringify({ type: "state_result", id: msg.id, error: String(err) }));
        }
      }
    };

    ws.onerror = () => {
      // Silently ignore — devtools server may not be running
    };

    ws.onclose = () => {
      ws = null;
      setTimeout(() => {
        if (appRef && stateRef) connect(appRef, stateRef);
      }, 2000);
    };
  }

  return { onLog, connect };
}
