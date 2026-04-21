const INTERRUPTED_MESSAGE_PATTERNS = [
  "all fibers interrupted without error",
  "request was aborted",
  "interrupted by user",
] as const;

export function isClaudeUserInterruptionDiagnostic(message: string | null | undefined): boolean {
  if (typeof message !== "string") {
    return false;
  }

  const normalized = message.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }

  return normalized.includes("[ede_diagnostic]") && normalized.includes("result_type=user");
}

export function isProviderInterruptionMessage(message: string | null | undefined): boolean {
  if (typeof message !== "string") {
    return false;
  }

  const normalized = message.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }

  return (
    INTERRUPTED_MESSAGE_PATTERNS.some((pattern) => normalized.includes(pattern)) ||
    isClaudeUserInterruptionDiagnostic(normalized)
  );
}
