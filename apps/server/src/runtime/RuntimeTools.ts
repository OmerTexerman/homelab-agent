// @effect-diagnostics nodeBuiltinImport:off
/**
 * RuntimeTools - the pure half of per-project runtime tools (issue #13).
 *
 * An agent registers a system package with `homelab tools add <spec>`. The
 * spec is validated here, stored in `runtime_tools`, installed into the live
 * container by the CLI (`installCommandsForTool`), and baked into a derived
 * image (`renderToolsDockerfile`) tagged `<baseFingerprint>-<toolsHash>`, so
 * the tools come back after every container recreate.
 *
 * Specs become Dockerfile `RUN` lines, so every part is matched against a
 * narrow allowlist: no whitespace, quotes, `$`, backticks, or backslashes can
 * get through, and every token is single-quoted on top of that.
 *
 * @module RuntimeTools
 */
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import type { RuntimeToolKind } from "@t3tools/contracts";

export interface ParsedRuntimeTool {
  readonly kind: RuntimeToolKind;
  /** The canonical spec string that is stored and hashed. */
  readonly spec: string;
  /** apt/pip/npm: the package argument (name plus optional version pin). */
  readonly packageArg?: string;
  /** url: the https source and the absolute in-container destination. */
  readonly url?: string;
  readonly dest?: string;
}

export type RuntimeToolSpecParseResult =
  | { readonly ok: true; readonly tool: ParsedRuntimeTool }
  | { readonly ok: false; readonly error: string };

/** Container label (and image label) carrying the tools hash; `none` for an empty list. */
export const RUNTIME_TOOLS_LABEL = "homelab.runtime.tools";
export const NO_RUNTIME_TOOLS = "none";
export const RUNTIME_TOOLS_IMAGE_REPOSITORY = "homelab-agent-runtime";

const VERSION = "[A-Za-z0-9][A-Za-z0-9.+~_-]{0,63}";
// Debian package names: lowercase alnum plus `+ - .`, starting alnum.
const APT_PATTERN = new RegExp(`^[a-z0-9][a-z0-9+.-]{0,127}(=${VERSION})?$`);
// PEP 508 names, optional `==` pin. No extras, markers, or URLs.
const PIP_PATTERN = new RegExp(`^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?(==${VERSION})?$`);
// npm names (optionally scoped), optional `@version` pin. No git or file specs.
const NPM_PATTERN = new RegExp(
  `^(@[a-z0-9][a-z0-9._-]{0,63}/)?[a-z0-9][a-z0-9._-]{0,127}(@${VERSION})?$`,
);
// https only; path and query from a conservative URL alphabet (no quotes, `$`, backticks, spaces).
const URL_PATTERN =
  /^https:\/\/[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?(\/[A-Za-z0-9._~%/+=,:@-]*)?(\?[A-Za-z0-9._~%/+=,:@&-]*)?$/;
const DEST_PATTERN = /^\/[A-Za-z0-9._/-]{1,255}$/;
/** Destinations that are bind mounts (the image copy would be hidden) or system-critical. */
const FORBIDDEN_DEST_PREFIXES = ["/workspace", "/runtime", "/proc", "/sys", "/dev"];

const fail = (error: string): RuntimeToolSpecParseResult => ({ ok: false, error });

/**
 * Parses and validates a tool spec. Returns the canonical form (trimmed, one
 * space between a url and its destination) or a message that says what is
 * wrong.
 */
export function parseRuntimeToolSpec(raw: string): RuntimeToolSpecParseResult {
  const input = raw.trim();
  const separator = input.indexOf(":");
  if (separator <= 0) {
    return fail("Tool specs look like apt:<pkg>, pip:<pkg>, npm:<pkg>, or url:<https url> <dest>.");
  }
  const kind = input.slice(0, separator);
  const value = input.slice(separator + 1);
  switch (kind) {
    case "apt":
      return APT_PATTERN.test(value)
        ? { ok: true, tool: { kind, spec: `apt:${value}`, packageArg: value } }
        : fail(`'${value}' is not a valid apt package name (optionally name=version).`);
    case "pip":
      return PIP_PATTERN.test(value)
        ? { ok: true, tool: { kind, spec: `pip:${value}`, packageArg: value } }
        : fail(`'${value}' is not a valid pip package name (optionally name==version).`);
    case "npm":
      return NPM_PATTERN.test(value)
        ? { ok: true, tool: { kind, spec: `npm:${value}`, packageArg: value } }
        : fail(`'${value}' is not a valid npm package name (optionally name@version).`);
    case "url": {
      const parts = value.trim().split(/ +/);
      if (parts.length !== 2 || /[\t\r\n]/.test(value)) {
        return fail("url tools need exactly two parts: url:<https url> <absolute dest path>.");
      }
      const [url = "", dest = ""] = parts;
      if (!URL_PATTERN.test(url)) {
        return fail(
          "url tools must use a plain https:// URL (no quotes, spaces, or shell characters).",
        );
      }
      try {
        if (new URL(url).protocol !== "https:") {
          return fail("url tools must use https.");
        }
      } catch {
        return fail(`'${url}' is not a valid URL.`);
      }
      const normalizedDest = NodePath.posix.normalize(dest);
      if (
        !DEST_PATTERN.test(dest) ||
        normalizedDest !== dest ||
        dest.endsWith("/") ||
        dest.split("/").includes("..")
      ) {
        return fail(`'${dest}' must be a normalized absolute file path like /usr/local/bin/tool.`);
      }
      if (
        FORBIDDEN_DEST_PREFIXES.some((prefix) => dest === prefix || dest.startsWith(`${prefix}/`))
      ) {
        return fail(`'${dest}' is inside a mounted or system directory; use e.g. /usr/local/bin.`);
      }
      return { ok: true, tool: { kind, spec: `url:${url} ${dest}`, url, dest } };
    }
    default:
      return fail(`Unknown tool kind '${kind}'. Use apt, pip, npm, or url.`);
  }
}

export const runtimeToolKindOf = (spec: string): RuntimeToolKind | undefined => {
  const parsed = parseRuntimeToolSpec(spec);
  return parsed.ok ? parsed.tool.kind : undefined;
};

/** Valid tools, sorted by spec, deduplicated. Invalid stored rows are dropped. */
export function normalizeRuntimeTools(
  specs: ReadonlyArray<string>,
): ReadonlyArray<ParsedRuntimeTool> {
  const bySpec = new Map<string, ParsedRuntimeTool>();
  for (const spec of specs) {
    const parsed = parseRuntimeToolSpec(spec);
    if (parsed.ok) bySpec.set(parsed.tool.spec, parsed.tool);
  }
  return [...bySpec.values()].toSorted((left, right) =>
    left.spec < right.spec ? -1 : left.spec > right.spec ? 1 : 0,
  );
}

const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

/** Hash of the sorted canonical specs; `none` for an empty list. */
export function runtimeToolsHash(tools: ReadonlyArray<ParsedRuntimeTool>): string {
  return tools.length === 0
    ? NO_RUNTIME_TOOLS
    : sha256(tools.map((tool) => tool.spec).join("\n")).slice(0, 12);
}

/** Short, tag-safe fingerprint of the base image's id. */
export function runtimeBaseImageFingerprint(baseImageId: string): string {
  return sha256(baseImageId).slice(0, 12);
}

export function runtimeToolsImageTag(baseFingerprint: string, toolsHash: string): string {
  return `${RUNTIME_TOOLS_IMAGE_REPOSITORY}:${baseFingerprint}-${toolsHash}`;
}

const quote = (value: string) => `'${value}'`;

/**
 * The derived image's Dockerfile: the base plus one RUN line per kind, in a
 * fixed order (apt, pip, npm, url) with specs sorted, so the same list always
 * renders the same bytes and Docker's layer cache is reused.
 */
export function renderToolsDockerfile(
  baseImageRef: string,
  tools: ReadonlyArray<ParsedRuntimeTool>,
): string {
  const sorted = normalizeRuntimeTools(tools.map((tool) => tool.spec));
  const of = (kind: RuntimeToolKind) => sorted.filter((tool) => tool.kind === kind);
  const packages = (kind: RuntimeToolKind) =>
    of(kind)
      .map((tool) => quote(tool.packageArg ?? ""))
      .join(" ");
  const lines = [`FROM ${baseImageRef}`];
  if (of("apt").length > 0) {
    lines.push(
      `RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${packages("apt")} && rm -rf /var/lib/apt/lists/*`,
    );
  }
  if (of("pip").length > 0) {
    lines.push(
      `RUN python3 -m pip install --break-system-packages --no-cache-dir ${packages("pip")}`,
    );
  }
  if (of("npm").length > 0) {
    lines.push(`RUN npm install -g ${packages("npm")} && npm cache clean --force`);
  }
  if (of("url").length > 0) {
    lines.push(
      `RUN ${of("url")
        .map((tool) => {
          const dest = tool.dest ?? "";
          return `mkdir -p ${quote(NodePath.posix.dirname(dest))} && curl -fsSL ${quote(tool.url ?? "")} -o ${quote(dest)} && chmod 0755 ${quote(dest)}`;
        })
        .join(" && ")}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** argv lists (run without a shell) that install one tool into a live container as root. */
export function installCommandsForTool(
  tool: ParsedRuntimeTool,
): ReadonlyArray<ReadonlyArray<string>> {
  switch (tool.kind) {
    case "apt":
      return [
        ["apt-get", "update"],
        ["apt-get", "install", "-y", "--no-install-recommends", tool.packageArg ?? ""],
      ];
    case "pip":
      return [
        [
          "python3",
          "-m",
          "pip",
          "install",
          "--break-system-packages",
          "--no-cache-dir",
          tool.packageArg ?? "",
        ],
      ];
    case "npm":
      return [["npm", "install", "-g", tool.packageArg ?? ""]];
    case "url": {
      const dest = tool.dest ?? "";
      return [
        ["mkdir", "-p", NodePath.posix.dirname(dest)],
        ["curl", "-fsSL", tool.url ?? "", "-o", dest],
        ["chmod", "0755", dest],
      ];
    }
  }
}

/**
 * Which tools list a runtime uses. The project's shared runtime uses the
 * project list; every other runtime (isolated clone, scratch, curator) has its
 * own, which a clone fills from its parent's list when it is created.
 */
export type RuntimeToolsOwner =
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "runtime"; readonly projectId: string; readonly runtimeId: string };

export function runtimeToolsOwnerFor(record: {
  readonly runtimeId: string;
  readonly projectId: string | null;
  readonly runtimeKind: string | null;
}): RuntimeToolsOwner | undefined {
  if (record.projectId === null) return undefined;
  const shared =
    record.runtimeKind === "project-shared" ||
    (record.runtimeKind === null && record.runtimeId.startsWith("project-runtime:"));
  return shared
    ? { kind: "project", projectId: record.projectId }
    : { kind: "runtime", projectId: record.projectId, runtimeId: record.runtimeId };
}
