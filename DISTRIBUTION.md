# Distribution Plan

## Overview

The framework is distributed as a single npm package with three concerns:

1. **Library** — the atoms, derived atoms, and `createApp` API
2. **MCP devtools server** — the browser-connected devtools for Claude
3. **Claude skills** — conventions that teach Claude how to use the framework

---

## Package structure

```
your-package/
  src/              ← library source (atom, asyncAtom, derivedAtom, createApp, ActionContext)
  skills/
    framework.md    ← state/actions/effects conventions
    ui.md           ← UI/app component conventions
  bin/
    devtools.js     ← MCP server entry point
    init.js         ← interactive first-time setup CLI
    postinstall.js  ← silent update script
```

---

## Library

Standard npm package. Users install and import:

```ts
import { atom, asyncAtom, derivedAtom, createApp } from "your-package";
import type { ActionContext } from "your-package";
```

---

## MCP devtools server

Published as the package `bin`, so users run it with `npx`:

```json
{
  "mcpServers": {
    "framework-devtools": {
      "command": "npx",
      "args": ["your-package"]
    }
  }
}
```

No global install required. Always runs the version matching the installed library.

---

## Claude skills

### First-time setup — `npx your-package init`

Run once after installing the package. Interactive:

1. Locates the project root by walking up from `node_modules` looking for `.claude/`
2. Lists available skills with descriptions
3. Prompts the user to select which ones to install (multi-select)
4. Copies selected skill files into `.claude/skills/your-package/`
5. Writes a `.claude/skills/your-package/.manifest.json` recording the installed skills and a checksum of each file

```
? Which skills would you like to install?
  ◉ framework  State, actions, and effects conventions
  ◉ ui         UI/app component separation conventions
```

If `.claude/` does not exist the user is warned and nothing is written — the project may not be using Claude Code.

### Updates — `postinstall`

Runs automatically on every `npm install`. Non-interactive:

1. Skips entirely if `process.env.CI` is set
2. Looks for `.claude/skills/your-package/.manifest.json` — if absent, does nothing (user has not run init, or opted out)
3. For each skill recorded in the manifest:
   - Computes the current checksum of the installed file
   - If it matches the manifest checksum → the file is unmodified → overwrite with the updated skill and update the manifest checksum
   - If it does not match → the user has edited the file → print a warning and skip

```
[your-package] Updating Claude skills...
  ✓ framework  updated
  ⚠ ui         skipped — local modifications detected (run `npx your-package sync` to force)
```

### Forced sync — `npx your-package sync`

Explicit command to overwrite all managed skills regardless of local modifications. The user opts into losing their changes.

### The manifest

`.claude/skills/your-package/.manifest.json`:

```json
{
  "version": "1.4.0",
  "skills": {
    "framework": { "checksum": "sha256:abc123..." },
    "ui":        { "checksum": "sha256:def456..." }
  }
}
```

Used by postinstall to detect user edits and by sync to know what is managed.

---

## Conventions for users

- **Do not edit managed skill files.** They are overwritten on update.
- To extend a skill, create a separate file alongside it (e.g. `.claude/skills/my-overrides/SKILL.md`) and reference it in `CLAUDE.md`.
- The `.manifest.json` should be committed to version control so the postinstall update check works correctly across the team.
- The skill files themselves should also be committed — they are part of the project's Claude configuration.

---

## Lifecycle summary

```
npm install your-package
  └─ postinstall.js runs
       └─ no manifest found → does nothing, prints "Run npx your-package init to set up Claude skills"

npx your-package init
  └─ user selects skills → copied + manifest written

npm install your-package@next  (upgrade)
  └─ postinstall.js runs
       └─ manifest found → updates unmodified skills, warns on modified ones
```
