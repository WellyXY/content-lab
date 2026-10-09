import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Built-in tools of the recreate session. There is deliberately no Bash: checks run through
 * fixed-argument MCP tools (see tools.ts), so nothing the agent writes reaches a shell.
 */
export const RECREATE_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Skill"];

/** Files and folders the agent may read but never write: anything a tool or the session loads as configuration. */
const PROTECTED_NAMES = new Set(["CLAUDE.md", "AGENTS.md", "package.json", "package-lock.json", "hyperframes.json", "meta.json", "node_modules"]);

type Decision = { behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string };

/** Workspace-relative path of a target inside `root` (a realpath; symlinks resolved), or null when it is outside. */
export function workspaceRelative(root: string, raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  // The CLI expands "~" itself, and "file:" or URLs are never workspace files.
  if (raw.startsWith("~") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  const target = resolve(root, raw);
  // Resolve the deepest existing ancestor so symlinks cannot point outside.
  let probe = target;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  const real = resolve(realpathSync(probe), relative(probe, target));
  if (real !== root && !real.startsWith(root + sep)) return null;
  return relative(root, real);
}

export function createRecreateToolGuard(workspace: string, skills: readonly string[]) {
  const root = realpathSync(workspace);
  const locate = (raw: unknown): string | null => workspaceRelative(root, raw);
  const writable = (path: string): boolean => path !== "" && path.split(sep).every((part) => !part.startsWith(".") && !PROTECTED_NAMES.has(part));
  const allow = (input: Record<string, unknown>): Decision => ({ behavior: "allow", updatedInput: input });
  const deny = (message: string): Decision => ({ behavior: "deny", message });

  return async (toolName: string, input: Record<string, unknown>): Promise<Decision> => {
    switch (toolName) {
      case "Read":
        return locate(input.file_path) !== null ? allow(input) : deny("Only files inside the workspace can be read.");
      case "Write": case "Edit": {
        const path = locate(input.file_path);
        if (path === null) return deny("Only files inside the workspace can be written.");
        return writable(path) ? allow(input) : deny("Configuration files, dotfiles and node_modules are read-only.");
      }
      case "Glob": case "Grep": {
        // Patterns are paths too: refuse absolute, home-relative or parent-relative ones.
        const patterns = [toolName === "Glob" ? input.pattern : undefined, input.glob].filter((value): value is string => typeof value === "string");
        if (patterns.some((pattern) => isAbsolute(pattern) || pattern.startsWith("~") || pattern.split("/").includes(".."))) return deny("Search inside the workspace only.");
        return input.path === undefined || locate(input.path) !== null ? allow(input) : deny("Search inside the workspace only.");
      }
      case "Skill": {
        // The input key has varied between CLI versions; an unknown shape is refused and the agent can Read the skill files instead.
        const name = [input.skill, input.command, input.name].find((value): value is string => typeof value === "string");
        return name !== undefined && skills.includes(name.replace(/^\//, "")) ? allow(input) : deny(`Available skills: ${skills.join(", ")}; their files are under .claude/skills/.`);
      }
      default:
        return deny(`${toolName} is not available here; use the hyperframes_* and probe_media tools for checks.`);
    }
  };
}
