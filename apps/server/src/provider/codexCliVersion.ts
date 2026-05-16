export interface CodexCliVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const MIN_SUPPORTED_CODEX_CLI_VERSION: CodexCliVersion = {
  major: 0,
  minor: 37,
  patch: 0,
};

export function parseCodexCliVersion(output: string): CodexCliVersion | null {
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(output);
  if (!match) return null;
  const [, major, minor, patch] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
  };
}

function compareCodexCliVersion(left: CodexCliVersion, right: CodexCliVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function formatCodexCliVersion(version: CodexCliVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

export function isCodexCliVersionSupported(version: CodexCliVersion): boolean {
  return compareCodexCliVersion(version, MIN_SUPPORTED_CODEX_CLI_VERSION) >= 0;
}

export function formatCodexCliUpgradeMessage(version: CodexCliVersion): string {
  return `Codex CLI v${formatCodexCliVersion(
    version,
  )} is too old for T3 Code. Upgrade to v${formatCodexCliVersion(
    MIN_SUPPORTED_CODEX_CLI_VERSION,
  )} or newer and restart T3 Code.`;
}
