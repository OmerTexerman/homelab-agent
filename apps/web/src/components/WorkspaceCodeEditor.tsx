import CodeMirror from "@uiw/react-codemirror";
import { loadLanguage, type LanguageName } from "@uiw/codemirror-extensions-langs";
import { useMemo } from "react";

/**
 * Focused code editor for the container-backed workspace files panel. Wraps
 * CodeMirror with syntax highlighting derived from the file extension and the
 * app's resolved light/dark theme, replacing the plain textarea the fork
 * shipped originally.
 */
// Names are validated at runtime by loadLanguage (unknown names return null and
// simply skip highlighting), so a plain string map keeps this resilient to the
// exact LanguageName union shipped by the installed extensions-langs version.
const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  html: "html",
  htm: "html",
  vue: "vue",
  svelte: "svelte",
  css: "css",
  scss: "sass",
  sass: "sass",
  less: "less",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "properties",
  env: "properties",
  xml: "xml",
  sql: "sql",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
  lua: "lua",
  dart: "dart",
  r: "r",
};

function loadLanguageByName(name: string) {
  return loadLanguage(name as LanguageName);
}

function languageExtensionFor(path: string) {
  const base = path.split("/").pop()?.toLowerCase() ?? "";
  if (base === "dockerfile" || base.endsWith(".dockerfile")) {
    return loadLanguageByName("dockerfile");
  }
  if (base === "makefile") {
    return loadLanguageByName("shell");
  }
  const ext = base.includes(".") ? (base.split(".").pop() ?? "") : "";
  const language = EXTENSION_LANGUAGE[ext];
  return language ? loadLanguageByName(language) : null;
}

export function WorkspaceCodeEditor(props: {
  readonly value: string;
  readonly path: string;
  readonly theme: "light" | "dark";
  readonly readOnly?: boolean;
  readonly onChange?: (value: string) => void;
}) {
  const extensions = useMemo(() => {
    const language = languageExtensionFor(props.path);
    return language ? [language] : [];
  }, [props.path]);

  const readOnly = props.readOnly ?? false;
  return (
    <CodeMirror
      value={props.value}
      {...(props.onChange ? { onChange: props.onChange } : {})}
      extensions={extensions}
      theme={props.theme}
      height="100%"
      readOnly={readOnly}
      className="h-full min-h-full overflow-hidden rounded-md border border-border text-[12px]"
      basicSetup={{
        lineNumbers: true,
        foldGutter: true,
        highlightActiveLine: !readOnly,
        highlightActiveLineGutter: !readOnly,
        autocompletion: false,
      }}
    />
  );
}
