# React 19 Async Patterns & This Framework

## What React 19 adds

### `use(promise)` — Suspense for client components

`use()` is a new hook that unwraps a promise inside a component. While the
promise is pending, the component suspends and the nearest `<Suspense>` boundary
renders its fallback. When the promise resolves, the component renders with the
value.

```tsx
const data = use(somePromise); // suspends until resolved
```

Unlike other hooks, `use()` can be called conditionally and inside loops.
Errors go to the nearest Error Boundary — `try/catch` does not work around it.

**Critical requirement:** the promise must be stable across renders. Creating a
new promise inside the component on every render causes an infinite suspend loop.

### `useTransition` with async functions

In React 18, `startTransition` only accepted synchronous functions. In React 19
it accepts async functions. `isPending` stays `true` for the full duration — from
the first line of the async function until all resulting state updates have
committed.

```tsx
const [isPending, startTransition] = useTransition();

startTransition(async () => {
  await fetchData();
  setState(result); // isPending still true until this commits
});
```

One known limitation: state updates made *after* an `await` inside a transition
are not automatically carried as transition updates. This is expected to be fixed
in a future React release.

### `useActionState`

Wraps an async function that receives previous state and returns new state.
Designed for form-style interactions where the result of the async call *is* the
next state.

```tsx
const [result, dispatch, isPending] = useActionState(
  async (prev, formData) => {
    return await submitForm(formData);
  },
  initialState
);
```

`useActionState` is **not a good fit for this framework** — it requires actions
to return values, which conflicts with the rule that actions only drive state.

### `useOptimistic`

Shows a temporary optimistic value while an async transition is in-flight. When
the transition completes, the real value takes over automatically.

```tsx
const [optimisticTodos, addOptimistic] = useOptimistic(
  todos, // base value (from atom)
  (current, newTodo) => [...current, { ...newTodo, pending: true }]
);
```

The base value comes from an atom; `addOptimistic` must be called inside a
`startTransition` or form action.

---

## How this framework integrates

### `useTransition` — works today, no changes needed

Since actions return `Promise<void>`, they slot directly into transitions:

```tsx
const [isPending, startTransition] = useTransition();

<button onClick={() => startTransition(() => app.actions.fetchTodos())}>
  {isPending ? 'Loading…' : 'Fetch'}
</button>
```

This is the primary pattern for async actions that need a loading indicator.
No framework changes required.

### Promise atoms — transparent Suspense via `atom.use()`

Atoms can hold a `Promise<T>` as their value. When they do, `atom.use()` calls
React's `use()` internally and the component suspends automatically. From the
component's perspective, it always gets back the resolved type:

```ts
// state.ts
export const todos = atom<Promise<Todo[]>>(Promise.resolve([]));

// actions.ts
export function fetchTodos({ state, effects }: Ctx) {
  state.todos.set(effects.api.getTodos()); // store the promise directly
}

// Component — no manual use() needed
function TodoList() {
  const app = useApp();
  const todos = app.state.todos.use(); // suspends if promise is pending, returns Todo[]

  return <ul>{todos.map(t => <li key={t.id}>{t.title}</li>)}</ul>;
}
```

Wrap the component in a `<Suspense>` boundary:

```tsx
<Suspense fallback={<p>Loading…</p>}>
  <TodoList />
</Suspense>
```

The promise stored in the atom is stable (same reference until the action sets a
new one), which satisfies React's requirement for `use()`.

**The return type of `.use()` is automatically inferred:**
- `atom<Todo[]>` → `.use()` returns `Todo[]`
- `atom<Promise<Todo[]>>` → `.use()` returns `Todo[]` (unwrapped, suspending)

### `useOptimistic` — component-level escape hatch

`useOptimistic` works against atom values as its base state, but the optimistic
layer lives in the component, not in `state.ts`. This is an acceptable trade-off
since optimistic state is purely cosmetic (it reverts automatically on error and
has no business logic):

```tsx
function TodoList() {
  const app = useApp();
  const todos = app.state.todos.use();
  const [optimisticTodos, addOptimistic] = useOptimistic(
    todos,
    (current, newTodo: Todo) => [...current, { ...newTodo, pending: true }]
  );

  function handleAdd() {
    startTransition(async () => {
      addOptimistic(pendingTodo);
      await app.actions.addTodo(pendingTodo);
    });
  }
}
```

---

## Summary

| Pattern | Fits framework? | Notes |
|---------|----------------|-------|
| `useTransition` + async action | ✅ Native fit | Already works, no changes |
| Promise atom + `use()` | ✅ Native fit | Atom guarantees promise stability |
| `useOptimistic` | ⚠️ Escape hatch | Lives in component, not state.ts |
| `useActionState` | ❌ Conflicts | Requires actions to return values |
