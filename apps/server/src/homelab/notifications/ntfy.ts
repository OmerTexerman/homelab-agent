/**
 * The ntfy sink: one HTTP POST to the topic URL, message in the body, the
 * rest in ntfy's headers (`Title`, `Priority`, `Tags`, `Click`, and
 * `Authorization: Bearer <token>` when a token is set). Header values that
 * aren't plain ASCII are sent RFC 2047-encoded, which ntfy decodes.
 *
 * @module ntfy
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

/** ntfy priorities: 1 min, 2 low, 3 default, 4 high, 5 urgent. */
export type NtfyPriority = 1 | 2 | 3 | 4 | 5;

export interface NtfyMessage {
  readonly title: string;
  readonly body: string;
  readonly priority: NtfyPriority;
  readonly tags?: ReadonlyArray<string>;
  /** Absolute URL opened when the notification is tapped. */
  readonly click?: string;
}

export interface NtfyTarget {
  readonly url: string;
  readonly token: string | null;
}

export class NtfyDeliveryError extends Schema.TaggedError<NtfyDeliveryError>()(
  "NtfyDeliveryError",
  {
    message: Schema.String,
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 3500;

const clip = (value: string, max: number) =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

/** One line, printable, RFC 2047 when it isn't ASCII. */
export function encodeNtfyHeaderValue(value: string): string {
  const oneLine = value.replace(/[\r\n\t]+/g, " ").trim();
  if (/^[\x20-\x7e]*$/.test(oneLine)) return oneLine;
  let binary = "";
  for (const byte of new TextEncoder().encode(oneLine)) binary += String.fromCharCode(byte);
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

/** The headers ntfy reads for `message`. */
export function ntfyHeaders(message: NtfyMessage, token: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "text/plain; charset=utf-8",
    title: encodeNtfyHeaderValue(clip(message.title, MAX_TITLE_LENGTH)),
    priority: String(message.priority),
  };
  if (message.tags !== undefined && message.tags.length > 0) {
    headers.tags = encodeNtfyHeaderValue(message.tags.join(","));
  }
  if (message.click !== undefined) headers.click = message.click;
  const trimmedToken = token?.trim();
  if (trimmedToken) headers.authorization = `Bearer ${trimmedToken}`;
  return headers;
}

/** POSTs `message` to the topic. Fails on a transport error or a non-2xx answer. */
export const sendNtfy = Effect.fn("sendNtfy")(function* (target: NtfyTarget, message: NtfyMessage) {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.post(target.url).pipe(
    HttpClientRequest.setHeaders(ntfyHeaders(message, target.token)),
    HttpClientRequest.bodyText(clip(message.body, MAX_BODY_LENGTH), "text/plain; charset=utf-8"),
  );
  const response = yield* client
    .execute(request)
    .pipe(
      Effect.mapError(
        (cause) =>
          new NtfyDeliveryError({ message: `ntfy request failed: ${cause.message}`, cause }),
      ),
    );
  // Drain the body so the connection is released; its contents don't matter.
  const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
  if (response.status < 200 || response.status >= 300) {
    return yield* new NtfyDeliveryError({
      message: `ntfy answered ${response.status}${text ? `: ${clip(text.trim(), 200)}` : ""}`,
      status: response.status,
    });
  }
  return { status: response.status };
});
