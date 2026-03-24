---
name: state-management
description: >
  Conventions for working with the custom state management framework used in this
  project. Use this skill whenever the user asks to add, modify, or remove state,
  actions, or effects — or when adding any new feature to the app that involves
  data, logic, or external APIs. Also use it when the user asks how something
  works or where something should go. This framework has specific conventions that
  differ from Redux, Zustand, and other common patterns, so always consult this
  skill before writing any code in state.ts, actions.ts, effects.ts, or main.tsx.
---

# Framework Conventions

This project uses a custom state management framework with a strict separation of
concerns across three files. All app logic lives in these files — components only
read state and call actions.

## File responsibilities

| File | What goes here |
|------|---------------|
| `src/state.ts` | All app state, defined as atoms |
| `src/actions.ts` | All business logic — reads/writes state, calls effects |
| `src/effects.ts` | Environment and third-party integrations |
| `src/main.tsx` | Wires everything together via `createApp`, exports `useApp` |

## state.ts — atoms

Every piece of state is either an `atom` (synchronous) or an `asyncAtom`
(fetched asynchronously on init). Choose based on one rule:

> **If the initial value comes from an async source (API, storage, etc.), use
> `asyncAtom`. Otherwise use `atom`.**

```ts
import { atom, asyncAtom } from "agentic-react";

// Synchronous — value is always known immediately
export const count = atom(0);
export const searchQuery = atom("");

// Asynchronous — value is loaded from an effect on init
export const posts = asyncAtom<Post[]>();
export const currentUser = asyncAtom<User>();

// Namespaced
export const user = {
  name: atom(""),
  age: atom(0),
};
```

### Why two primitives?

`atom` uses `useSyncExternalStore` — the right choice for synchronous state
(prevents tearing) but it forces re-renders outside React's concurrent
scheduler, which breaks `Suspense` and `useTransition` when mutations occur.

`asyncAtom` uses `useReducer` + `useEffect` internally, so updates flow through
React's own scheduler. This makes `Suspense`, `useTransition`, and
`startTransition` all work correctly. The trade-off is that brief tearing is
possible during concurrent rendering, which is acceptable for async data.

## actions.ts — business logic

Actions are plain exported functions. They receive a `ActionContext` as the first
argument and an optional payload as the second. They can be async.

Actions can return values when needed — for example to integrate with React 19's
`useActionState`. Prefer writing results to atoms for anything shared across the
app; only return a value when the caller genuinely needs it directly (e.g. a form
submission result). If you need to share reusable computation, write a plain
utility function (outside the exported action tree) and call it from within
actions.

Define a single `Ctx` alias at the top of `actions.ts` using `typeof import` — never write the types by hand:

```ts
import type { ActionContext } from "agentic-react";

type Ctx = ActionContext<
  typeof import("./state"),
  typeof import("./actions"),
  typeof import("./effects")
>;
```

Then use `Ctx` for every action in the file:

```ts
export function increment({ state, effects }: Ctx) {
  effects.counter.increment();
  state.count.set(effects.counter.value);
}

// namespaced
export const user = {
  async fetchProfile({ state, effects }: Ctx, payload: { id: string }) {
    const profile = await effects.api.getUser(payload.id);
    state.user.name.set(profile.name);
  }
};
```

### ActionContext API

Inside an action, the context gives you:

- **`state`** — write access to every atom:
  - `state.count.set(newValue)` — replace the value
  - `state.count.update(n => n + 1)` — derive from current value
  - `state.count.get()` — read current value (synchronous)
- **`actions`** — call other actions: `actions.someOtherAction(payload)`
- **`effects`** — the instantiated effect objects (see below)

### asyncAtom write API

`asyncAtom` exposes one extra method in addition to `set`, `update`, and `get`:

- `state.posts.load(promise)` — triggers the async load; call this in `initialize` with the effect's promise
- `state.posts.get()` — throws if called before the atom is loaded; safe to call after `load` resolves
- `state.posts.set(value)` — synchronous replacement (rarely needed directly)
- `state.posts.update(fn)` — synchronous update; use this for mutations after initial load

### Async state pattern

For any `asyncAtom`, the pattern is always:
1. `initialize` action calls `state.x.load(effects.y.fetch())` — kicks off the async load
2. Mutations call `state.x.update(fn)` synchronously first (instant UI feedback), then `await` the persist effect

```ts
// actions.ts
export function initialize({ state, effects }: Ctx) {
  state.posts.load(effects.api.getPosts()); // kicks off load, returns immediately
}

export async function addPost({ state, effects }: Ctx, title: string) {
  state.posts.update(posts => [...posts, { id: crypto.randomUUID(), title }]); // instant
  await effects.api.savePost(title); // background persist
}
```

The synchronous `update` before `await` is the optimistic update — the UI
reflects the change immediately without any extra primitives.

## effects.ts — environment and third-party APIs

Effects are factory functions: `(env) => object`. The `env` object is whatever
is passed to `createApp({ env: ... })` in `main.tsx`. Each factory returns an
object with methods and/or getters.

```ts
export function counter() {
  let count = 0;
  return {
    increment() { count++; },
    decrement() { count--; },
    get value() { return count; },  // getters work fine
  };
}

export function api(env: { apiUrl: string }) {
  return {
    async getUser(id: string) {
      const res = await fetch(`${env.apiUrl}/users/${id}`);
      return res.json();
    }
  };
}

// namespaced
export const storage = {
  local: (env) => ({
    get: (key: string) => localStorage.getItem(key),
    set: (key: string, value: string) => localStorage.setItem(key, value),
  }),
};
```

## main.tsx — wiring

`createApp` is called once with all three modules imported via `* as`:

```tsx
import { createApp } from "agentic-react";
import { createContext, useContext } from "react";
import * as state from "./state";
import * as actions from "./actions";
import * as effects from "./effects";

const app = createApp({ state, actions, effects });
const AppContext = createContext(app);

export function useApp() {
  return useContext(AppContext);
}
```

`createApp` returns `{ state, actions, setState }` — it does **not** return
`useApp`. `useApp` is defined manually in `main.tsx` using React context.

`env` is **optional**. Only include it when at least one effect factory actually
declares an `env` parameter. If no effects need configuration, omit `env`
entirely — do not pass `env: {}`.

## Components

Components access the app via `useApp()`. State is read with `.use()`. Actions
are called directly.

```tsx
function MyComponent() {
  const app = useApp();
  const count = app.state.count.use();
  const userName = app.state.user.name.use();

  return (
    <button onClick={() => app.actions.increment()}>
      {count}
    </button>
  );
}
```

### asyncAtom in components — Suspense

`asyncAtom.use()` suspends the component while the initial load is pending.
Wrap any component that reads an `asyncAtom` in a `<Suspense>` boundary.
After the load resolves, `.use()` returns the value directly — no loading
checks needed.

```tsx
// App.tsx
function App() {
  return (
    <Suspense fallback={<p>Loading...</p>}>
      <PostList />
    </Suspense>
  );
}

function PostList() {
  const app = useApp();
  const posts = app.state.posts.use(); // suspends until loaded, always Post[] after
  // ...
}
```

### Async mutations — useTransition

Wrap async action calls in `startTransition` to keep the UI responsive during
the background persist. `isPending` can be used to show a saving indicator.

```tsx
const [isPending, startTransition] = useTransition();

function handleAdd(title: string) {
  startTransition(async () => {
    await app.actions.addPost(title);
  });
}
```

### Do NOT use useOptimistic with this framework

`useOptimistic` is designed for React Server Components / Server Actions, where
the "real" state flows back through React's rendering tree. With this framework,
atom updates that occur during a transition cause React to render both the
updated base state and the pending optimistic state simultaneously — producing
visible duplicates or flickers.

The correct optimistic pattern is: **update the atom synchronously in the action
before `await`**. That synchronous update is the optimistic update. No extra
React primitives needed.

Components never manipulate state directly and never import from `state.ts` or
`actions.ts` — they only go through `useApp()`.

## Namespacing

All three layers support nested objects for organisation. There is no limit to
nesting depth, but one level is usually enough:

```ts
// state.ts
export const auth = { token: atom<string | null>(null), userId: atom<string | null>(null) };

// actions.ts
export const auth = {
  login({ state }: Ctx, payload: { token: string; userId: string }) {
    state.auth.token.set(payload.token);
    state.auth.userId.set(payload.userId);
  }
};

// effects.ts
export const auth = {
  session: (env) => ({
    save: (token: string) => localStorage.setItem("token", token),
    load: () => localStorage.getItem("token"),
  })
};
```

## Testing & Debugging

The `framework-devtools` MCP server is the primary tool for both **testing** new features and **debugging** problems. Use it proactively after implementing any action or state change — don't wait for the user to report a problem.

The server exposes four tools:

- **`get_logs`** — returns the buffered action/state-change log as formatted trees. Accepts an optional `limit` (default 50).
- **`clear_logs`** — clears the log buffer.
- **`get_state`** — returns a JSON snapshot of all current atom values, mirroring the shape of `state.ts`. `asyncAtom`s that haven't loaded yet appear as `"[pending]"`.
- **`trigger_action`** — runs a framework action in the browser directly. Use dot notation for the `path` (e.g. `"addTodo"`, `"auth.login"`), and pass an optional JSON-encoded `payload` (e.g. `"\"my title\""` or `"{\"id\":\"abc\"}"`).

### Testing after implementing a feature

After adding or changing actions, verify correctness using the MCP server — no need to click through the UI:

1. **`get_state`** — snapshot the state before the action so you have a baseline.
2. **`trigger_action`** — fire the action with a representative payload.
3. **`get_state`** again — confirm the state changed as expected.
4. **`get_logs`** — verify the full execution tree: correct state transitions, effects called, child actions in the right order.

For `asyncAtom` state, call `trigger_action` for `initialize` first if the atom shows `"[pending]"`.

### Debugging an issue

1. **`get_logs`** first — it shows every action that fired, the state transitions it caused, and the effects it called, as a readable tree.
2. **`get_state`** to inspect the current state at any moment.
3. **`trigger_action`** to reproduce a specific scenario without clicking through the UI.
4. **If the devtools server is not running** (no browser connected error), fall back to asking the user to paste the relevant console output from DevTools.

## What NOT to do

- Don't use `asyncAtom` for state that is always synchronously available — use `atom`
- Don't use `useOptimistic` — update atoms synchronously before `await` instead
- Don't call `asyncAtom.get()` before the atom is loaded (it throws) — only call it in mutations, which run after `initialize`
- Don't put logic in components — it belongs in actions
- Don't import atoms directly into components — use `useApp()`
- Don't put state inside effects — effects are stateless integrations (except
  for internal implementation details like a counter or cache)
- Don't create new files for state/actions/effects — everything goes in the
  three existing files, using namespacing for organisation
- Prefer writing results to state over returning values from actions — return values only when the caller needs them directly (e.g. `useActionState`); use plain utility functions for shared computation
