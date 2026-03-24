# agentic-react

State management for React 19 designed for AI-assisted development. Strict separation of state, actions, and effects — with MCP devtools that let your AI coding agent inspect and drive the app directly.

## Installation

```bash
npm install agentic-react
```

### Set up your AI tool

Run once after installing to configure your AI coding tool with framework conventions and MCP devtools:

```bash
npx agentic-react init
```

This detects which AI tools you have configured and installs the appropriate skills/rules and MCP server entry for each:

| Tool | Skills / Rules | MCP devtools |
|------|---------------|-------------|
| Claude Code | ✓ `state-management`, `component-composition` | ✓ |
| Cursor | ✓ `state-management`, `component-composition` | ✓ |
| OpenCode | ✓ `state-management`, `component-composition` | ✓ |
| Gemini CLI | ✓ injected into `GEMINI.md` | ✓ |
| Codex | ✓ injected into `AGENTS.md` | ✓ |

**Skills** teach your AI agent the framework conventions so it writes correct state, actions, and effects without needing to be told. **MCP devtools** let the agent inspect live app state and trigger actions directly from the editor.

---

## Quick start

Once `npx agentic-react init` has run, your AI agent knows the framework conventions. You work by describing what you want — the agent creates and updates the right files.

### Scaffold the app

Start by asking your agent to set up the initial structure:

> *"Set up a todo app with agentic-react. Use a REST API at `/api` for persistence."*

The agent will create four files:

| File | What goes here |
|------|---------------|
| `src/state.ts` | All app state as atoms |
| `src/actions.ts` | All business logic |
| `src/effects.ts` | External integrations (APIs, storage, etc.) |
| `src/main.tsx` | Wires everything together and exports `useApp` |

### Add features

Describe features in terms of what the user does — the agent figures out which files need to change:

> *"Add the ability to filter todos by all, active, and completed."*

The agent will add a `filter` atom to `state.ts`, a `setFilter` action to `actions.ts`, and wire filtering logic into a derived atom or action — without you specifying where each piece goes.

> *"When a todo is added, optimistically update the list before the API call resolves."*

The agent knows the optimistic update pattern for this framework: update the atom synchronously before `await`, so the UI reflects the change immediately with no extra primitives.

### Build the UI

Describe what to display — the agent keeps logic and presentation in separate layers:

> *"Add a TodoList component that shows the filtered todos with a checkbox to toggle each one."*

The agent creates a presentational `TodoItem` in `src/ui/` (props only, no app knowledge) and an app component in `src/App.tsx` that reads state, calls actions, and passes data down — following the component composition conventions from the installed skill.

### Verify with devtools

With the dev server running, the agent can inspect and drive the app directly through the MCP devtools — no manual clicking required:

> *"Check that adding a todo works correctly."*

The agent will trigger the `addTodo` action via `trigger_action`, then call `get_state` to confirm the todo appeared in state, and `get_logs` to verify the full execution — effects called, state transitions, correct order.

> *"The filter isn't working — debug it."*

The agent calls `get_logs` to see what fired, `get_state` to inspect the current atom values, and `trigger_action` to reproduce the scenario — then reads the code and fixes it.

---

## How it works

### Atoms

**`atom(initialValue)`** — synchronous state. Uses `useSyncExternalStore` internally, which prevents tearing but schedules updates outside React's concurrent scheduler. Use this for any value that is always available immediately.

**`asyncAtom<T>()`** — asynchronous state. Uses `useReducer` + `useEffect` internally so updates flow through React's own scheduler, making `Suspense` and `useTransition` work correctly. Call `state.x.load(promise)` once in `initialize` to start the load. After that, `state.x.use()` in a component suspends until resolved, then always returns `T` — no null checks needed.

**`derivedAtom(atoms, selector)`** — computed state derived from one or more atoms. Recomputes when any dependency changes.

### Actions

Actions are plain exported functions in `actions.ts`. They receive an `ActionContext` as the first argument which provides:

- `state` — read/write access to every atom
- `actions` — call other actions
- `effects` — the instantiated effect objects

State writes are synchronous and immediate. The optimistic update pattern is simply: update the atom before `await`, then persist in the background.

Actions are fully namespaced — nest them in objects for organisation (`export const auth = { login, logout }`).

### Effects

Effects are factory functions that receive `env` and return an object. They are the only place where external systems (APIs, localStorage, timers, etc.) are touched. Effects have no knowledge of state — they just do I/O and return values.

### Devtools (MCP)

When `onLog` is provided to `createApp`, the framework records every action execution as a tree: which state changed, which effects were called, and in what order. In development, pass `createDevtools()` to stream these trees to the MCP server over a local WebSocket.

The MCP server (`npx agentic-react`) exposes four tools to your AI agent:

| Tool | What it does |
|------|-------------|
| `get_logs` | Returns recent action execution trees — what ran, what state changed, what effects were called |
| `clear_logs` | Clears the log buffer |
| `get_state` | Snapshots all current atom values from the live browser app |
| `trigger_action` | Runs any action in the browser directly, by dot-notation path |
| `set_state` | Sets any atom value directly for debugging |

This lets your AI agent verify that new features work correctly without manual UI interaction — trigger an action, inspect the resulting state, check the execution log.

---

## API reference

### `atom(initialValue)`

```ts
const count = atom(0);

// In actions:
state.count.set(1);
state.count.update((n) => n + 1);
state.count.get(); // synchronous read

// In components:
const count = app.state.count.use();
```

### `asyncAtom<T>()`

```ts
const todos = asyncAtom<Todo[]>();

// In actions:
state.todos.load(effects.api.getTodos()); // start async load
state.todos.update((todos) => [...todos, newTodo]); // synchronous mutation
state.todos.set([]); // replace entirely
state.todos.get(); // synchronous read (throws if not yet loaded)

// In components (inside <Suspense>):
const todos = app.state.todos.use(); // suspends, then always returns Todo[]
```

### `derivedAtom(atoms, selector)`

```ts
const filteredTodos = derivedAtom([todos, filter], (todos, filter) =>
  filter === "all" ? todos : todos.filter((t) => t.completed === (filter === "completed"))
);
```

### `createApp({ state, actions, effects, env, onLog? })`

Returns `{ useApp }`. Call `useApp()` in components to access `app.state` and `app.actions`.

### `createDevtools()`

Returns an `onLog` handler that streams execution logs to the local MCP server over WebSocket. Only use in development.
