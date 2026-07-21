import { request } from "@t3tools/client-runtime/rpc";
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import { ORCHESTRATION_WS_METHODS, type ClientOrchestrationCommand } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

type CommandOf<T extends ClientOrchestrationCommand["type"]> = Extract<
  ClientOrchestrationCommand,
  { readonly type: T }
>;

function dispatch(command: ClientOrchestrationCommand) {
  return request(ORCHESTRATION_WS_METHODS.dispatchCommand, command);
}

/**
 * Homelab fork: atom commands for the fork-specific orchestration commands
 * (standalone/scratch thread lifecycle). Upstream's typed command atoms live
 * in `@t3tools/client-runtime/state/threads`; this module is the web glue for
 * the fork's additional command surface so components never need a raw
 * environment API handle.
 */
export const standaloneThreadEnvironment = {
  create: createEnvironmentCommand(connectionAtomRuntime, {
    label: "homelab:commands:thread:standalone-create",
    execute: (input: CommandOf<"thread.standalone.create">) => dispatch(input),
  }),
  promoteToProject: createEnvironmentCommand(connectionAtomRuntime, {
    label: "homelab:commands:thread:standalone-promote-to-project",
    execute: (input: CommandOf<"thread.standalone.promote-to-project">) => dispatch(input),
  }),
  moveToProject: createEnvironmentCommand(connectionAtomRuntime, {
    label: "homelab:commands:thread:standalone-move-to-project",
    execute: (input: CommandOf<"thread.standalone.move-to-project">) => dispatch(input),
  }),
};
