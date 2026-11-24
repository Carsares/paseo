import { AsyncLocalStorage } from "node:async_hooks";
// Keep the final identity check and spawn in the same turn. This runs only for explicit discovery.
// oxlint-disable-next-line paseo/no-sync-io
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export function captureLaunchFile(file: string) {
  const real = realpathSync(file);
  const stat = statSync(real, { bigint: true });
  if (!stat.isFile()) throw new Error("Custom CLI launch file is unavailable");
  return {
    file,
    real,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

export type LaunchFileIdentity = ReturnType<typeof captureLaunchFile>;

export function assertLaunchFiles(files: LaunchFileIdentity[]): void {
  try {
    if (files.every((file) => isDeepStrictEqual(file, captureLaunchFile(file.file)))) return;
  } catch {
    // Keep file details out of discovery errors.
  }
  throw new Error("Custom CLI launch file changed");
}

interface ScopedLaunch {
  adapter: string;
  providerId: string;
  cwd: string;
  argv: string[];
  operations?: Record<ScopedOpenCodeOperation, { argv: string[]; appendPort?: true }>;
  env: NodeJS.ProcessEnv;
  file: string;
  entrypoint: string;
  entrypointArgs: string[];
  files: LaunchFileIdentity[];
  signal?: AbortSignal;
}

export type ScopedOpenCodeOperation =
  | "opencode.version"
  | "opencode.serve.v1"
  | "opencode.serve.v2";

const launchScope = new AsyncLocalStorage<
  ScopedLaunch & { processCwd: string; active: boolean; assertCurrent: () => void }
>();

interface OpenCodeDiscoveryContext {
  active: boolean;
  started: boolean;
  prepare: (cwd: string) => Promise<ReturnType<typeof bindCustomProviderLaunch>>;
}

const openCodeDiscovery = new AsyncLocalStorage<OpenCodeDiscoveryContext>();

export function bindOpenCodeDiscovery(prepare: OpenCodeDiscoveryContext["prepare"]) {
  return async function run<T>(operation: () => Promise<T>): Promise<T> {
    const context = { active: true, started: false, prepare };
    try {
      return await openCodeDiscovery.run(context, operation);
    } finally {
      context.active = false;
    }
  };
}

export function currentOpenCodeDiscovery(): boolean {
  return openCodeDiscovery.getStore() !== undefined;
}

export async function prepareOwnedOpenCodeLaunch(cwd: string) {
  const context = openCodeDiscovery.getStore();
  if (!context?.active || context.started) throw new Error("OpenCode launch is not authorized");
  context.started = true;
  const binding = await context.prepare(cwd);
  return {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      if (openCodeDiscovery.getStore() !== context || !context.active) {
        throw new Error("OpenCode launch is not authorized");
      }
      return binding.run(operation);
    },
  };
}

export function captureLaunchDirectory(cwd: string) {
  const real = realpathSync(cwd);
  const stat = statSync(real, { bigint: true });
  if (!stat.isDirectory()) throw new Error("Custom CLI launch directory is unavailable");
  return { cwd, real, dev: stat.dev, ino: stat.ino };
}

export function bindCustomProviderLaunch(
  launch: ScopedLaunch,
  directory = captureLaunchDirectory(launch.cwd),
) {
  function assertCurrent() {
    if (launch.signal?.aborted) throw new Error("Custom CLI discovery stopped");
    try {
      if (!isDeepStrictEqual(captureLaunchDirectory(launch.cwd), directory)) {
        throw new Error("Directory changed");
      }
    } catch {
      throw new Error("Custom CLI launch directory changed");
    }
    assertLaunchFiles(launch.files);
  }

  return {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      assertCurrent();
      const scope = { ...launch, processCwd: directory.real, active: true, assertCurrent };
      try {
        return await launchScope.run(scope, operation);
      } finally {
        scope.active = false;
      }
    },
    assertCurrent,
  };
}

export function currentCustomProviderLaunch() {
  return launchScope.getStore();
}

function matchesLaunchArgv(
  scope: ScopedLaunch,
  argv: string[],
  operation?: ScopedOpenCodeOperation,
): boolean {
  if (!scope.operations) return operation === undefined && isDeepStrictEqual(argv, scope.argv);
  if (!operation) return false;
  const permitted = scope.operations[operation];
  if (!permitted) return false;
  if (!permitted.appendPort) return isDeepStrictEqual(argv, permitted.argv);
  const port = argv.at(-1);
  return (
    port !== undefined &&
    /^[1-9]\d{0,4}$/u.test(port) &&
    Number(port) <= 65_535 &&
    isDeepStrictEqual(argv, [...permitted.argv, port])
  );
}

function matchesLaunchEnvironment(
  scope: ScopedLaunch,
  env: NodeJS.ProcessEnv,
  overlays: NodeJS.ProcessEnv[] = [],
  operation?: ScopedOpenCodeOperation,
): boolean {
  const expected = Object.assign({}, scope.env, ...overlays);
  if (!isDeepStrictEqual(env, expected)) return false;
  return Object.entries(expected).every(([key, value]) => {
    if (scope.env[key] === value) return true;
    if (scope.adapter === "acp" || scope.adapter === "copilot") {
      return (
        (key === "NO_BROWSER" && value === "true") ||
        (scope.adapter === "copilot" && key === "COPILOT_AUTO_UPDATE" && value === "false")
      );
    }
    return (
      scope.adapter === "opencode" &&
      (operation === "opencode.serve.v1" || operation === "opencode.serve.v2") &&
      (key === "OPENCODE_CONFIG_CONTENT" ||
        (operation === "opencode.serve.v2" && key === "OPENCODE_PASSWORD"))
    );
  });
}

export function assertScopedLaunch(input: {
  adapter: string;
  operation?: ScopedOpenCodeOperation;
  providerId?: string;
  cwd: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  file: string | null;
  envOverlays?: NodeJS.ProcessEnv[];
}): Pick<ScopedLaunch, "entrypoint" | "entrypointArgs"> | undefined {
  const scope = currentCustomProviderLaunch();
  if (!scope) return;
  const inputCwd = path.resolve(input.cwd);
  if (
    !scope.active ||
    scope.signal?.aborted ||
    scope.adapter !== input.adapter ||
    (input.providerId !== undefined && scope.providerId !== input.providerId) ||
    (inputCwd !== scope.cwd && inputCwd !== scope.processCwd) ||
    input.file !== scope.file ||
    !matchesLaunchArgv(scope, input.argv, input.operation) ||
    !matchesLaunchEnvironment(scope, input.env, input.envOverlays, input.operation)
  ) {
    throw new Error("Custom CLI launch did not match discovery authorization");
  }
  scope.assertCurrent();
  return scope;
}
