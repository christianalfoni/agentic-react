import { useSyncExternalStore, use as usePromise, useReducer, useEffect } from "react";

// ─── Atom ──────────────────────────────────────────────────────────────────

const ATOM_MARKER = Symbol("atom");

export function atom<T>(initialValue: T) {
  let value = initialValue;
  const listeners = new Set<() => void>();

  const notify = () => listeners.forEach((fn) => fn());

  return {
    [ATOM_MARKER]: true as const,
    read: {
      use(): T extends Promise<infer U> ? U : T {
        const snapshot = useSyncExternalStore(
          (fn) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
          },
          () => value,
        );
        if (snapshot instanceof Promise) {
          return usePromise(snapshot) as any;
        }
        return snapshot as any;
      },
    },
    write: {
      get: () => value,
      set(next: T): T {
        value = next;
        notify();
        return value;
      },
      update(fn: (current: T) => T): T {
        value = fn(value);
        notify();
        return value;
      },
    },
    toJSON: () => value,
  };
}

// ─── AsyncAtom ─────────────────────────────────────────────────────────────
//
// Uses useReducer + useEffect instead of useSyncExternalStore so that updates
// flow through React's own scheduler. This makes Suspense, useTransition, and
// startTransition all work correctly — store mutations are treated as normal
// React state updates rather than forced synchronous re-renders that bypass
// the concurrent scheduler.

const ASYNC_ATOM_MARKER = Symbol("asyncAtom");

type AsyncAtomInternalState<T> =
  | { status: "pending"; promise: Promise<T> }
  | { status: "fulfilled"; value: T }
  | { status: "error"; error: unknown };

export function asyncAtom<T>() {
  let state: AsyncAtomInternalState<T> = {
    status: "pending",
    promise: new Promise(() => {}),
  };
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((fn) => fn());

  return {
    [ASYNC_ATOM_MARKER]: true as const,
    read: {
      use(): T {
        // useReducer dispatch is stable and flows through React's scheduler,
        // unlike useSyncExternalStore which forces synchronous re-renders.
        const [, rerender] = useReducer((n: number) => n + 1, 0);
        const capturedState = state;

        useEffect(() => {
          listeners.add(rerender);
          // Catch any state change that occurred between render and effect commit
          if (state !== capturedState) rerender();
          return () => {
            listeners.delete(rerender);
          };
        }, []);

        // Initial load: React's Suspense mechanism handles retry when the
        // promise resolves — no listener needed for this phase.
        // Subsequent mutations: the useEffect listener above handles re-renders.
        if (state.status === "pending") return usePromise(state.promise) as T;
        if (state.status === "error") throw state.error;
        return state.value;
      },
    },
    write: {
      get(): T {
        if (state.status !== "fulfilled") {
          throw new Error("asyncAtom.get() called before atom is loaded");
        }
        return state.value;
      },
      load(promise: Promise<T>) {
        state = { status: "pending", promise };
        notify();
        promise.then(
          (value) => {
            state = { status: "fulfilled", value };
            notify();
          },
          (error) => {
            state = { status: "error", error };
            notify();
          },
        );
      },
      set(value: T): T {
        state = { status: "fulfilled", value };
        notify();
        return value;
      },
      update(fn: (current: T) => T): T {
        if (state.status !== "fulfilled") {
          throw new Error("asyncAtom.update() called before atom is loaded");
        }
        state = { status: "fulfilled", value: fn(state.value) };
        notify();
        return state.value;
      },
    },
    toJSON: () =>
      state.status === "fulfilled" ? state.value : `[${state.status}]`,
  };
}

type Atom = ReturnType<typeof atom>;
type AsyncAtom = ReturnType<typeof asyncAtom>;

const isAtom = (v: unknown): v is Atom =>
  typeof v === "object" && v !== null && ATOM_MARKER in v;

const isAsyncAtom = (v: unknown): v is AsyncAtom =>
  typeof v === "object" && v !== null && ASYNC_ATOM_MARKER in v;

// ─── DerivedAtom ────────────────────────────────────────────────────────────

const DERIVED_ATOM_MARKER = Symbol("derivedAtom");

type AnySource = Atom | AsyncAtom | DerivedAtom<any>;

type SourceValue<S> = S extends ReturnType<typeof atom<infer T>>
  ? T
  : S extends ReturnType<typeof asyncAtom<infer T>>
  ? T
  : S extends DerivedAtom<infer T>
  ? T
  : never;

type DerivedAtom<T> = {
  [DERIVED_ATOM_MARKER]: true;
  read: { use(): T };
  getValue(): T;
  toJSON(): T | string;
};

export function derivedAtom<Sources extends AnySource[], T>(
  sources: [...Sources],
  selector: (...values: { [K in keyof Sources]: SourceValue<Sources[K]> }) => T,
): DerivedAtom<T> {
  const getValue = (): T =>
    selector(
      ...(sources.map((s) => {
        if (isAtom(s)) return s.write.get();
        if (isAsyncAtom(s)) return s.write.get();
        return (s as DerivedAtom<any>).getValue();
      }) as any),
    );

  return {
    [DERIVED_ATOM_MARKER]: true as const,
    read: {
      use(): T {
        const values = sources.map((s) => s.read.use());
        return selector(...(values as any));
      },
    },
    getValue,
    toJSON: () => {
      try {
        return getValue();
      } catch {
        return "[pending]";
      }
    },
  };
}

const isDerivedAtom = (v: unknown): v is DerivedAtom<any> =>
  typeof v === "object" && v !== null && DERIVED_ATOM_MARKER in v;

// ─── Tree types ────────────────────────────────────────────────────────────

type StateTree = Atom | AsyncAtom | DerivedAtom<any> | { [key: string]: StateTree };
type ActionTree = Action | { [key: string]: ActionTree };
type EffectTree = Effect | { [key: string]: EffectTree };

// ─── Public types ──────────────────────────────────────────────────────────

type Action = (context: any, payload?: any) => any;
type Effect = (env: Record<string, any>) => Record<string, any>;

type WriteStateTree<T> = T extends Atom
  ? T["write"]
  : T extends AsyncAtom
  ? T["write"]
  : T extends DerivedAtom<infer U>
  ? { get(): U }
  : { [K in keyof T]: WriteStateTree<T[K]> };

type ReadStateTree<T> = T extends Atom
  ? T["read"]
  : T extends AsyncAtom
  ? T["read"]
  : T extends DerivedAtom<any>
  ? T["read"]
  : { [K in keyof T]: ReadStateTree<T[K]> };

type WrappedActionTree<T> = T extends Action
  ? Parameters<T> extends [any]
    ? () => ReturnType<T>
    : (payload: Parameters<T>[1]) => ReturnType<T>
  : { [K in keyof T]: WrappedActionTree<T[K]> };

type InstantiatedEffectTree<T> = T extends Effect
  ? ReturnType<T>
  : { [K in keyof T]: InstantiatedEffectTree<T[K]> };

// Constraints removed — the mapped types enforce correctness at the call site.
export type ActionContext<S, A, E> = {
  state: { [K in keyof S]: WriteStateTree<S[K]> };
  actions: { [K in keyof A]: WrappedActionTree<A[K]> };
  effects: { [K in keyof E]: InstantiatedEffectTree<E[K]> };
};

type ReadContext<S, A> = {
  state: { [K in keyof S]: ReadStateTree<S[K]> };
  actions: { [K in keyof A]: WrappedActionTree<A[K]> };
};

// ─── Execution tracking ────────────────────────────────────────────────────

export type ExecutionEvent =
  | { type: "state"; path: string; from: unknown; to: unknown }
  | { type: "effect"; path: string; args: unknown[]; result: unknown }
  | { type: "child"; node: ExecutionNode };

export type ExecutionNode = {
  id: number;
  actionPath: string;
  payload: unknown;
  events: ExecutionEvent[];
};

let executionCounter = 0;
const executionStack: ExecutionNode[] = [];

const currentExecution = (): ExecutionNode | null =>
  executionStack[executionStack.length - 1] ?? null;

const recordEvent = (event: ExecutionEvent) => currentExecution()?.events.push(event);

// ─── Execution tree renderer ───────────────────────────────────────────────

function safeStringify(value: unknown): string {
  if (value instanceof Promise) return "[Promise]";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function renderExecutionTree(node: ExecutionNode, prefix: string, indent: string): string[] {
  const payloadStr =
    node.payload !== undefined ? ` (${JSON.stringify(node.payload)})` : "";
  const lines: string[] = [`${prefix}[${node.id}] ${node.actionPath}${payloadStr}`];

  node.events.forEach((event, i) => {
    const last = i === node.events.length - 1;
    const branch = indent + (last ? "└─ " : "├─ ");
    const nextIndent = indent + (last ? "   " : "│  ");

    if (event.type === "state") {
      lines.push(
        `${branch}state.${event.path}: ${safeStringify(event.from)} → ${safeStringify(event.to)}`,
      );
    } else if (event.type === "effect") {
      const args = event.args.map((a) => safeStringify(a)).join(", ");
      const result =
        event.result !== undefined ? ` → ${safeStringify(event.result)}` : "";
      lines.push(`${branch}effects.${event.path}(${args})${result}`);
    } else {
      lines.push(...renderExecutionTree(event.node, branch, nextIndent));
    }
  });

  return lines;
}

const flushExecutionTree = (
  node: ExecutionNode,
  onLog?: (node: ExecutionNode) => void,
) => {
  console.log(renderExecutionTree(node, "", "").join("\n"));
  onLog?.(node);
};

// ─── Helpers ───────────────────────────────────────────────────────────────

const mapTree = (
  obj: Record<string, any>,
  fn: (value: any, key: string) => any,
): Record<string, any> =>
  Object.fromEntries(Object.keys(obj).map((k) => [k, fn(obj[k], k)]));

// ─── State ─────────────────────────────────────────────────────────────────

function buildReadState(node: StateTree): any {
  if (isAtom(node)) return node.read;
  if (isAsyncAtom(node)) return node.read;
  if (isDerivedAtom(node)) return node.read;
  return mapTree(node as Record<string, any>, (child) => buildReadState(child));
}

// Intercepts writes to record state-change events against the current execution.
function buildWriteState(node: StateTree, path: string): any {
  if (isAtom(node)) {
    const { get, set, update } = node.write;
    return {
      get,
      set(next: unknown) {
        const from = get();
        const result = set(next as any);
        recordEvent({ type: "state", path, from, to: next });
        return result;
      },
      update(fn: (v: unknown) => unknown) {
        const from = get();
        const result = update(fn as any);
        recordEvent({ type: "state", path, from, to: get() });
        return result;
      },
    };
  }
  if (isAsyncAtom(node)) {
    const { get, load, set, update } = node.write;
    const safeGet = () => {
      try {
        return get();
      } catch {
        return "[pending]";
      }
    };
    return {
      get,
      load(promise: Promise<unknown>) {
        const from = safeGet();
        load(promise as any);
        recordEvent({ type: "state", path, from, to: "[loading]" });
      },
      set(next: unknown) {
        const from = safeGet();
        const result = set(next as any);
        recordEvent({ type: "state", path, from, to: next });
        return result;
      },
      update(fn: (v: unknown) => unknown) {
        const from = safeGet();
        const result = update(fn as any);
        recordEvent({ type: "state", path, from, to: safeGet() });
        return result;
      },
    };
  }
  if (isDerivedAtom(node)) return { get: () => node.getValue() };
  return mapTree(node as Record<string, any>, (child, key) =>
    buildWriteState(child, path ? `${path}.${key}` : key),
  );
}

// ─── Effects ───────────────────────────────────────────────────────────────

function instantiateEffectTree(node: EffectTree, env: Record<string, any>): any {
  if (typeof node === "function") return node(env);
  return mapTree(node as Record<string, any>, (child) =>
    instantiateEffectTree(child, env),
  );
}

// Wraps every method on an effect instance to record effect-call events.
// Getters and other descriptors are preserved as-is.
function wrapEffectInstance(instance: Record<string, any>, path: string): Record<string, any> {
  const wrapped: Record<string, any> = {};
  for (const key of Object.getOwnPropertyNames(instance)) {
    const descriptor = Object.getOwnPropertyDescriptor(instance, key)!;
    if (typeof descriptor.value === "function") {
      Object.defineProperty(wrapped, key, {
        ...descriptor,
        value(...args: any[]) {
          const result = descriptor.value.apply(instance, args);
          recordEvent({ type: "effect", path: `${path}.${key}`, args, result });
          return result;
        },
      });
    } else {
      Object.defineProperty(wrapped, key, descriptor);
    }
  }
  return wrapped;
}

function wrapEffectTree(instance: any, schema: EffectTree, path: string): any {
  if (typeof schema === "function") return wrapEffectInstance(instance, path);
  return mapTree(schema as Record<string, any>, (child, key) =>
    wrapEffectTree(instance[key], child, path ? `${path}.${key}` : key),
  );
}

// ─── Actions ───────────────────────────────────────────────────────────────

// alwaysRoot = true  → used for app.actions (external calls are always root executions)
// alwaysRoot = false → used for ctx.actions  (stack-based parent detection)
//
// Keeping two sets prevents async-interleaving mis-parenting: if an async root
// action is awaiting and a new external action is dispatched, the external call
// is correctly treated as its own root rather than a child of the pending async.
function buildWrappedActions(
  actionTree: Record<string, ActionTree>,
  getContext: () => ActionContext<any, any, any>,
  path: string,
  alwaysRoot: boolean,
  onLog?: (node: ExecutionNode) => void,
): Record<string, any> {
  return mapTree(actionTree, (node, key) => {
    const fullPath = path ? `${path}.${key}` : key;

    if (typeof node === "function") {
      return (payload?: any) => {
        const execNode: ExecutionNode = {
          id: ++executionCounter,
          actionPath: fullPath,
          payload,
          events: [],
        };

        const isRoot = alwaysRoot || executionStack.length === 0;

        if (!isRoot) {
          currentExecution()!.events.push({ type: "child", node: execNode });
        }

        executionStack.push(execNode);
        const result = node(getContext(), payload);

        if (result instanceof Promise) {
          return result.finally(() => {
            executionStack.pop();
            if (isRoot) flushExecutionTree(execNode, onLog);
          });
        }

        executionStack.pop();
        if (isRoot) flushExecutionTree(execNode, onLog);
        return result;
      };
    }

    return buildWrappedActions(
      node as Record<string, ActionTree>,
      getContext,
      fullPath,
      alwaysRoot,
      onLog,
    );
  });
}

// ─── Core ──────────────────────────────────────────────────────────────────

export function createApp<
  S extends Record<string, StateTree>,
  A extends Record<string, ActionTree>,
  E extends Record<string, EffectTree>,
  V extends Record<string, any>,
>({
  state,
  actions,
  effects,
  env,
  onLog,
}: {
  state: S;
  actions: A;
  effects: E;
  env: V;
  onLog?: (node: ExecutionNode) => void;
}) {
  const instantiatedEffects = instantiateEffectTree(effects as EffectTree, env);
  const wrappedEffects = wrapEffectTree(instantiatedEffects, effects as EffectTree, "");
  const writeState = buildWriteState(state as unknown as StateTree, "");

  // Context used inside actions: child actions use stack-based parent detection.
  const contextActions = buildWrappedActions(actions, getContext, "", false, onLog);

  // Actions exposed on the app object: always treated as root executions.
  const appActions = buildWrappedActions(actions, getContext, "", true, onLog);

  function getContext(): ActionContext<any, any, any> {
    return { state: writeState, actions: contextActions, effects: wrappedEffects };
  }

  function setState(path: string, value: unknown): void {
    const parts = path.split(".");
    let node: unknown = writeState;
    for (let i = 0; i < parts.length - 1; i++) {
      node = (node as Record<string, unknown>)[parts[i]];
      if (!node) throw new Error(`No state at path segment "${parts[i]}" in "${path}"`);
    }
    const last = parts[parts.length - 1];
    const atom = (node as Record<string, { set: (v: unknown) => void }>)[last];
    if (!atom || typeof atom.set !== "function") {
      throw new Error(`No atom with .set() at path "${path}"`);
    }
    atom.set(value);
  }

  return {
    state: buildReadState(state as unknown as StateTree),
    actions: appActions,
    setState,
  } as ReadContext<S, A> & { setState: (path: string, value: unknown) => void };
}
