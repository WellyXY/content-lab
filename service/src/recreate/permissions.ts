import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

export const RECREATE_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Skill"];
const HYPERFRAMES_SUBCOMMANDS = new Set(["lint", "check", "snapshot", "inspect", "catalog"]);
const SHELL_META = /[;&|`$<>\\\n]|\.\.\//;

type Decision = { behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string };

export function createRecreateToolGuard(workspace: string) {
  const root = realpathSync(workspace);
  const inside = (raw: unknown): boolean => {
    if (typeof raw !== "string" || raw.length === 0) return false;
    const target = resolve(root, raw);
    // Resolve the deepest existing ancestor so symlinks cannot point outside.
    let probe = target;
    while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
    const real = resolve(realpathSync(probe), target.slice(probe.length).replace(/^\//, ""));
    return real === root || real.startsWith(root + sep);
  };
  const allow = (input: Record<string, unknown>): Decision => ({ behavior: "allow", updatedInput: input });
  const deny = (message: string): Decision => ({ behavior: "deny", message });

  return async (toolName: string, input: Record<string, unknown>): Promise<Decision> => {
    switch (toolName) {
      case "Read": case "Write": case "Edit":
        return inside(input.file_path) ? allow(input) : deny("Only files inside the workspace are allowed.");
      case "Glob": case "Grep": {
        // Patterns are paths too: refuse absolute or parent-relative ones.
        const patterns = [toolName === "Glob" ? input.pattern : undefined, input.glob].filter((value): value is string => typeof value === "string");
        if (patterns.some((pattern) => isAbsolute(pattern) || pattern.startsWith("~") || pattern.split("/").includes(".."))) return deny("Search inside the workspace only.");
        return input.path === undefined || inside(input.path) ? allow(input) : deny("Search inside the workspace only.");
      }
      case "Skill":
        return allow(input);
      case "Bash": {
        const command = typeof input.command === "string" ? input.command.trim() : "";
        if (!command || SHELL_META.test(command)) return deny("Only a single plain command is allowed.");
        const parts = command.split(/\s+/);
        if (parts[0] === "npx" && parts[1] === "hyperframes" && HYPERFRAMES_SUBCOMMANDS.has(parts[2] ?? "")) return allow(input);
        if (parts[0] === "ffprobe") {
          const files = parts.slice(1).filter((part) => !part.startsWith("-") && !/^(error|quiet|json|default.*|stream.*|format.*)$/.test(part));
          return files.every((file) => !isAbsolute(file) && inside(file)) ? allow(input) : deny("ffprobe only on workspace files.");
        }
        return deny("Allowed: npx hyperframes lint|check|snapshot|inspect|catalog, ffprobe.");
      }
      default:
        return deny(`${toolName} is not available here.`);
    }
  };
}
