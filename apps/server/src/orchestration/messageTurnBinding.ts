export function isPendingUserMessageLike<T extends { role: string; turnId: unknown }>(
  message: T,
): boolean {
  return message.role === "user" && message.turnId === null;
}

export function findLatestPendingUserMessageLike<T extends { role: string; turnId: unknown }>(
  messages: ReadonlyArray<T>,
): T | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && isPendingUserMessageLike(message)) {
      return message;
    }
  }
  return undefined;
}
