import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { EditorTarget, EditorTargetRuntime } from "../target.js";

// RebasedProperties.kt packages io.github.detachhead.rebased as Rebased.app.
const APPLICATION_NAME = "Rebased";
const execFileAsync = promisify(execFile);

async function resolveRepoRoot(
  workspacePath: string,
  runtime: EditorTargetRuntime,
): Promise<string> {
  // Resolve from the requested directory even if Paseo inherited Git variables
  // pointing at another checkout.
  const env = { ...runtime.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: workspacePath,
      env,
      timeout: 3000,
    });
    return stdout.replace(/\r?\n$/u, "");
  } catch (cause) {
    throw new Error(`Could not resolve a Git repository root for Rebased: ${workspacePath}`, {
      cause,
    });
  }
}

export const rebasedTarget: EditorTarget = {
  id: "rebased",
  async describe() {
    return {
      id: this.id,
      label: APPLICATION_NAME,
      kind: "editor",
      icon: { kind: "symbol", name: "terminal" },
    };
  },
  async isInstalled(runtime) {
    return runtime.hasMacApplication(APPLICATION_NAME);
  },
  async supportsWorkspace(workspacePath, runtime) {
    try {
      await resolveRepoRoot(workspacePath, runtime);
      return true;
    } catch {
      return false;
    }
  },
  async launch({ workspacePath }, runtime) {
    const applicationPath = runtime.getMacApplicationBundle(APPLICATION_NAME);
    if (!applicationPath) throw new Error("Rebased is not installed");

    const repoRoot = await resolveRepoRoot(workspacePath, runtime);
    await runtime.openMacApplication({
      applicationName: APPLICATION_NAME,
      applicationPath,
      paths: [repoRoot],
    });
  },
};
