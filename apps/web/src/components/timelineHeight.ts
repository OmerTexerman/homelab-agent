export function estimateTimelineMessageHeight(
  message: { readonly role: "user" | "assistant" | "system"; readonly text: string },
  input: { readonly timelineWidthPx: number },
): number {
  const width = Math.max(240, input.timelineWidthPx);
  const charsPerLine = Math.max(28, Math.floor(width / 7.4));
  const lineCount = Math.max(1, Math.ceil(message.text.length / charsPerLine));
  const verticalPadding = message.role === "user" ? 40 : 48;
  return verticalPadding + lineCount * 20;
}
