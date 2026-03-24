---
name: component-composition
description: >
  Component architecture conventions for this project. Use this skill when
  building or modifying any React components — whether adding new UI, refactoring
  existing components, or deciding where logic or styling should live. This skill
  ALWAYS use this skill whenever the work involves the component layer.
---

# UI Component Conventions

This project separates components into two distinct layers. The rule is simple:

> **UI components** are about *how things look*. **App components** are about *what things do*.

## UI components — `src/ui/`

UI components are pure presentational components. They:

- Accept all data and callbacks via **props** — no app state access
- Own all **styling** — native elements and style attributes live here
- May have **internal React state** for purely visual concerns (open/closed, hover, animation)
- Are **reusable** — they have no knowledge of the app's domain

```tsx
// src/ui/Button.tsx
type Props = {
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
};

export function Button({ onClick, disabled, children }: Props) {
  return (
    <button onClick={onClick} disabled={disabled} style={{ fontWeight: "bold" }}>
      {children}
    </button>
  );
}
```

```tsx
// src/ui/TodoItem.tsx
type Props = {
  title: string;
  completed: boolean;
  onToggle: () => void;
  onRemove: () => void;
};

export function TodoItem({ title, completed, onToggle, onRemove }: Props) {
  return (
    <li>
      <input type="checkbox" checked={completed} onChange={onToggle} />
      <span style={{ textDecoration: completed ? "line-through" : "none" }}>
        {title}
      </span>
      <button onClick={onRemove}>Remove</button>
    </li>
  );
}
```

## App components — `src/App.tsx`

App components wire UI components to the framework. They:

- Use `useApp()` to read state and call actions
- **Only render UI components** — no native elements (`div`, `ul`, `input`, etc.), no inline styles
- Handle **transitions and async** concerns (`useTransition`, `startTransition`)
- Are **not reusable** — they are specific to the app's structure

```tsx
// src/App.tsx
function TodoApp() {
  const app = useApp();
  const todos = app.state.filteredTodos.use();
  const [isPending, startTransition] = useTransition();

  return (
    <TodoList>
      {todos.map((todo) => (
        <TodoItem
          key={todo.id}
          title={todo.title}
          completed={todo.completed}
          onToggle={() => startTransition(() => app.actions.toggleTodo(todo.id))}
          onRemove={() => startTransition(() => app.actions.removeTodo(todo.id))}
        />
      ))}
    </TodoList>
  );
}
```

## The boundary rule

The clearest way to check which layer a piece of code belongs in:

| Question | Answer → layer |
|---|---|
| Does it know about `useApp`, actions, or atoms? | App component |
| Does it have a `style` prop or native element? | UI component |
| Could it be used in a completely different app without changes? | UI component |
| Does it read from `app.state` or call `app.actions`? | App component |

## File layout

```
src/
  ui/           ← all UI components
    TodoItem.tsx
    FilterBar.tsx
    TodoForm.tsx
    ...
  App.tsx       ← all app components
  main.tsx
  state.ts
  actions.ts
  effects.ts
```

## What NOT to do

- Don't put `style` attributes or native elements in app components
- Don't call `useApp()` inside UI components
- Don't pass the entire `app` object as a prop to a UI component — pass only the specific values and callbacks it needs
- Don't create app components inside `src/ui/` — the folder is strictly for reusable UI
