import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Expand a leading `~` in user-supplied paths before passing them to spawned
 * processes. Child process env values are not shell-expanded, so `CODEX_HOME`
 * would otherwise be treated as a literal relative path.
 */
export function expandHomePath(value: string): string {
  if (!value) return value;
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}
