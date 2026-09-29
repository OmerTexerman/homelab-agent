/**
 * Copy for a pairing link that an already-paired device failed to exchange.
 * The server answers every unusable one-time token (expired, already used,
 * revoked, unknown) with the same `invalid_credential` rejection, so the copy
 * names all of them; anything else keeps its own message.
 */
export function describeRePairFailure(
  error: unknown,
  isCredentialRejected: (error: unknown) => boolean,
): string {
  if (isCredentialRejected(error)) {
    return "The server rejected this pairing link. It has expired, was already used, or was revoked. Ask for a fresh link and open it again.";
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "The pairing link could not be exchanged. Try again with a fresh link.";
}
