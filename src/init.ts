import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function init() {
  const projectRoot = findProjectRoot();
  const results: string[] = [];

  if (existsSync(join(projectRoot, ".claude"))) {
    installClaudeSkills(projectRoot, results);
    configureMcpJson(join(projectRoot, ".mcp.json"), results, "Claude Code");
  }

  if (existsSync(join(projectRoot, ".cursor"))) {
    installCursorRules(projectRoot, results);
    configureMcpJson(join(projectRoot, ".cursor", "mcp.json"), results, "Cursor");
  }

  if (existsSync(join(projectRoot, ".opencode")) || existsSync(join(projectRoot, "opencode.json"))) {
    installOpenCodeSkills(projectRoot, results);
    configureOpenCode(join(projectRoot, "opencode.json"), results);
  }

  if (existsSync(join(projectRoot, ".gemini"))) {
    injectIntoInstructionFile(join(projectRoot, "GEMINI.md"), results, "Gemini CLI");
    configureMcpJson(join(projectRoot, ".gemini", "settings.json"), results, "Gemini CLI");
  }

  if (existsSync(join(projectRoot, ".codex"))) {
    injectIntoInstructionFile(join(projectRoot, "AGENTS.md"), results, "Codex");
    configureCodex(join(projectRoot, ".codex", "config.toml"), results);
  }

  if (results.length === 0) {
    console.log("[agentic-react] No AI coding tools detected (.claude, .cursor, .opencode, .gemini, .codex)");
    console.log("  Run this from your project root after initializing your AI tool.");
    return;
  }

  console.log("[agentic-react] Setup complete:");
  for (const line of results) {
    console.log(line);
  }
}

function findProjectRoot(): string {
  let dir = process.cwd();
  while (true) {
    if (existsSync(join(dir, "package.json")) || existsSync(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

// ─── Skills / Rules ──────────────────────────────────────────────────────────

function installClaudeSkills(projectRoot: string, results: string[]) {
  const skillsSourceDir = resolve(__dirname, "..", "skills");
  const skillsDestDir = join(projectRoot, ".claude", "skills", "agentic-react");

  mkdirSync(skillsDestDir, { recursive: true });

  for (const skill of ["state-management", "component-composition"]) {
    copyFileSync(join(skillsSourceDir, `${skill}.md`), join(skillsDestDir, `${skill}.md`));
    results.push(`  ✓ Claude Code skill: .claude/skills/agentic-react/${skill}.md`);
  }
}

function installOpenCodeSkills(projectRoot: string, results: string[]) {
  const skillsSourceDir = resolve(__dirname, "..", "skills");

  // OpenCode reads SKILL.md files inside named directories
  for (const skill of ["state-management", "component-composition"]) {
    const skillDestDir = join(projectRoot, ".opencode", "skills", `agentic-react-${skill}`);
    mkdirSync(skillDestDir, { recursive: true });
    const src = readFileSync(join(skillsSourceDir, `${skill}.md`), "utf8");
    // Update the name field in frontmatter to match the directory name
    const updated = src.replace(/^(---\nname: )\S+/m, `$1agentic-react-${skill}`);
    writeFileSync(join(skillDestDir, "SKILL.md"), updated);
    results.push(`  ✓ OpenCode skill: .opencode/skills/agentic-react-${skill}/SKILL.md`);
  }
}

function installCursorRules(projectRoot: string, results: string[]) {
  const skillsSourceDir = resolve(__dirname, "..", "skills");
  const rulesDestDir = join(projectRoot, ".cursor", "rules");

  mkdirSync(rulesDestDir, { recursive: true });

  const descriptions: Record<string, string> = {
    "state-management":
      "Conventions for the custom state management framework. Apply when modifying state.ts, actions.ts, effects.ts, or main.tsx, or when adding or removing state, actions, or effects.",
    "component-composition":
      "Component architecture conventions. Apply when building or modifying React components — whether adding new UI, refactoring existing components, or deciding where logic or styling should live.",
  };

  for (const skill of ["state-management", "component-composition"]) {
    const src = readFileSync(join(skillsSourceDir, `${skill}.md`), "utf8");
    const body = stripFrontmatter(src);
    const mdc = `---\ndescription: ${descriptions[skill]}\nalwaysApply: false\n---\n${body}`;
    writeFileSync(join(rulesDestDir, `agentic-react-${skill}.mdc`), mdc);
    results.push(`  ✓ Cursor rule: .cursor/rules/agentic-react-${skill}.mdc`);
  }
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("---", 3);
  if (end === -1) return content;
  return content.slice(end + 3).trimStart();
}

function injectIntoInstructionFile(filePath: string, results: string[], toolName: string) {
  const skillsSourceDir = resolve(__dirname, "..", "skills");
  const relative = filePath.replace(process.cwd() + "/", "");
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  let content = existing;
  const injected: string[] = [];
  const skipped: string[] = [];

  for (const skill of ["state-management", "component-composition"]) {
    const startMarker = `<!-- agentic-react:${skill}:start -->`;
    const endMarker = `<!-- agentic-react:${skill}:end -->`;

    if (content.includes(startMarker)) {
      skipped.push(skill);
      continue;
    }

    const body = stripFrontmatter(readFileSync(join(skillsSourceDir, `${skill}.md`), "utf8"));
    content += `\n${startMarker}\n${body.trimEnd()}\n${endMarker}\n`;
    injected.push(skill);
  }

  if (injected.length > 0) {
    writeFileSync(filePath, content);
    results.push(`  ✓ ${toolName} instructions: ${injected.join(", ")} injected into ${relative}`);
  }
  if (skipped.length > 0) {
    results.push(`  ~ ${toolName} instructions: ${skipped.join(", ")} already present in ${relative}`);
  }
}

// ─── MCP configuration ───────────────────────────────────────────────────────

function configureMcpJson(configPath: string, results: string[], toolName: string) {
  let config: { mcpServers?: Record<string, unknown> } = {};

  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {}
  }

  if (!config.mcpServers) config.mcpServers = {};

  const relative = configPath.replace(process.cwd() + "/", "");

  if (config.mcpServers["agentic-react"]) {
    results.push(`  ~ ${toolName} MCP: already configured (${relative})`);
    return;
  }

  config.mcpServers["agentic-react"] = {
    command: "npx",
    args: ["agentic-react"],
  };

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  results.push(`  ✓ ${toolName} MCP configured: ${relative}`);
}

function configureOpenCode(configPath: string, results: string[]) {
  let config: { mcp?: Record<string, unknown> } = {};

  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {}
  }

  if (!config.mcp) config.mcp = {};

  const relative = configPath.replace(process.cwd() + "/", "");

  if (config.mcp["agentic-react"]) {
    results.push(`  ~ OpenCode MCP: already configured (${relative})`);
    return;
  }

  config.mcp["agentic-react"] = {
    type: "local",
    command: ["npx", "agentic-react"],
    enabled: true,
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  results.push(`  ✓ OpenCode MCP configured: ${relative}`);
}

function configureCodex(configPath: string, results: string[]) {
  const relative = configPath.replace(process.cwd() + "/", "");
  const entry = `\n[mcp_servers.agentic-react]\ncommand = "npx"\nargs = ["agentic-react"]\nenabled = true\n`;

  if (existsSync(configPath)) {
    const existing = readFileSync(configPath, "utf8");
    if (existing.includes("[mcp_servers.agentic-react]")) {
      results.push(`  ~ Codex MCP: already configured (${relative})`);
      return;
    }
    writeFileSync(configPath, existing + entry);
  } else {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, entry.trimStart());
  }

  results.push(`  ✓ Codex MCP configured: ${relative}`);
}
