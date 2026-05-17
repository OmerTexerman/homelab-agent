// @effect-diagnostics nodeBuiltinImport:off
import type { ThreadRuntimeLaunchContext } from "../Services/ThreadRuntime.ts";
import {
  planManagedOpenCodeRuntimeServer,
  providerProcessCwdForLaunchContext,
  type ManagedOpenCodeRuntimeServerPlan,
} from "./RuntimeExecutionContext.ts";

export interface ProviderRuntimeEnvironment {
  readonly launchContext: ThreadRuntimeLaunchContext;
  readonly commandPath: string;
  readonly processCwd: string;
  readonly providerCwd: string;
  readonly runtimeHomePath: string;
  readonly runtimeWorkspacePath: string;
  readonly hostWorkspacePath: string;
  readonly hostHomePath: string;
  readonly hostBinDir: string;
  readonly env: Readonly<Record<string, string>>;
  readonly managedOpenCodeServer: ManagedOpenCodeRuntimeServerPlan | null;
}

export function buildProviderRuntimeEnvironment(input: {
  readonly launchContext: ThreadRuntimeLaunchContext;
  readonly commandPath: string;
}): ProviderRuntimeEnvironment {
  const processCwd = providerProcessCwdForLaunchContext(input.launchContext);
  return {
    launchContext: input.launchContext,
    commandPath: input.commandPath,
    processCwd,
    providerCwd: input.launchContext.execution.cwd,
    runtimeHomePath: input.launchContext.execution.homePath,
    runtimeWorkspacePath: input.launchContext.execution.workspacePath,
    hostWorkspacePath: input.launchContext.hostWorkspacePath,
    hostHomePath: input.launchContext.hostHomePath,
    hostBinDir: input.launchContext.hostBinDir,
    env: input.launchContext.execution.env,
    managedOpenCodeServer: planManagedOpenCodeRuntimeServer(input),
  };
}
