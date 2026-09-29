import { CommandId } from "@t3tools/contracts";

import { randomUUID } from "../lib/utils";

/**
 * Command ids for the fork's raw orchestration dispatches (scratch, curator,
 * standalone move). Upstream's typed command atoms mint their own ids, so
 * `lib/utils` no longer exports this.
 */
export const newCommandId = (): CommandId => CommandId.make(randomUUID());
