import {
  assertScopedLaunch,
  currentCustomProviderLaunch,
  type ScopedOpenCodeOperation,
} from "../../scoped-custom-provider-launch.js";
import {
  spawnScopedProviderProcess,
  stopScopedProviderProcess,
} from "../../scoped-provider-process.js";

interface OpenCodeLaunch {
  operation: ScopedOpenCodeOperation;
  cwd: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  envOverlays?: NodeJS.ProcessEnv[];
  signal?: AbortSignal;
}

function resolveManagedOpenCodeLaunch(input: OpenCodeLaunch) {
  input.signal?.throwIfAborted();
  const scope = currentCustomProviderLaunch();
  if (scope?.adapter !== "opencode") throw new Error("OpenCode launch is not authorized");

  // The binding already resolved and verified the executable and its interpreter.
  const checked = assertScopedLaunch({
    ...input,
    adapter: "opencode",
    file: scope.file,
  });
  if (!checked) throw new Error("OpenCode launch is not authorized");
  return {
    command: checked.entrypoint,
    args: [...checked.entrypointArgs, ...input.argv.slice(1)],
    cwd: scope.processCwd,
  };
}

export function spawnManagedOpenCodeProcess(input: OpenCodeLaunch) {
  const launch = resolveManagedOpenCodeLaunch(input);
  const child = spawnScopedProviderProcess({
    ...launch,
    env: input.env,
    // A local wrapper may dispatch to an installation beyond its own verified files.
    activity: { family: "opencode", keys: [], opaque: true },
  });
  return { ...launch, process: child };
}

export async function readManagedOpenCodeVersion(input: OpenCodeLaunch): Promise<string> {
  const { process: child } = spawnManagedOpenCodeProcess(input);
  let output = "";
  let resolveCompletion!: (success: boolean) => void;
  const completion = new Promise<boolean>((resolve) => {
    resolveCompletion = resolve;
  });
  let finished = false;
  const finish = (success: boolean) => {
    if (finished) return;
    finished = true;
    resolveCompletion(success);
  };
  const onAbort = () => finish(false);
  const timer = setTimeout(onAbort, 5_000);
  let succeeded: boolean;
  try {
    // Wait for exit, since a descendant may still hold the child's output pipes.
    child.once("exit", (code) => finish(code === 0));
    child.once("error", onAbort);
    child.stdin.on("error", onAbort);
    child.stdin.end();
    child.stderr.resume();
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk.slice(0, 8_193 - output.length);
      if (output.length > 8_192) finish(false);
    });
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    succeeded = await completion;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
    await stopScopedProviderProcess(child);
  }
  return succeeded && output.length <= 8_192 ? output : "";
}
