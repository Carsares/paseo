import { constants } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
export { findExecutableWithoutProbing as findInstallationLaunchPath } from "../../../executable-resolution/executable-resolution.js";

const RELEASE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const PackageMetadata = z.object({
  name: z.string(),
  bin: z.union([z.string(), z.record(z.string(), z.string())]),
});

async function packageOwnsCommand(
  owner: string,
  packageName: string,
  command: string,
): Promise<boolean> {
  try {
    const manifest = await open(
      path.join(owner, "package.json"),
      constants.O_RDONLY | constants.O_NONBLOCK,
    );
    try {
      const info = await manifest.stat();
      if (!info.isFile() || info.size > 64 * 1024) return false;
      const data = Buffer.alloc(info.size + 1);
      const { bytesRead } = await manifest.read(data, 0, data.length, 0);
      if (bytesRead !== info.size) return false;
      const parsed = PackageMetadata.safeParse(JSON.parse(data.toString("utf8", 0, bytesRead)));
      if (!parsed.success || parsed.data.name !== packageName) return false;
      const { bin } = parsed.data;
      const entries = typeof bin === "string" ? [bin] : Object.values(bin);
      return entries.some((entry) => path.resolve(owner, entry) === command);
    } finally {
      await manifest.close();
    }
  } catch {
    return false;
  }
}

/** Activity keys describe possible overlap, not executable provenance. */
export async function readInstallationActivityKeys(launchPath: string): Promise<string[]> {
  if (!path.isAbsolute(launchPath)) return [];
  try {
    const realPath = await realpath(launchPath);
    await access(realPath, constants.X_OK);
    const file = await stat(realPath, { bigint: true });
    if (!file.isFile()) return [];
    const keys = [`file:${file.dev}:${file.ino}`, `path:${realPath}`];
    if (launchPath !== realPath) keys.push(`path:${launchPath}`);

    const parent = path.dirname(realPath);
    if (RELEASE.test(path.basename(realPath)) && path.basename(parent) === "versions") {
      const root = path.dirname(parent);
      const home = await realpath(homedir()).catch(() => homedir());
      const standardRoot = path.join(home, ".local/share/claude");
      if (root === standardRoot) keys.push(`root:${root}`);
    }

    const dirs = realPath.split(path.sep);
    const modules = dirs.lastIndexOf("node_modules");
    if (modules > 0) {
      const packageEnd = dirs[modules + 1]?.startsWith("@") ? modules + 3 : modules + 2;
      const root = dirs.slice(0, modules + 1).join(path.sep);
      const owner = dirs.slice(0, packageEnd).join(path.sep);
      const packageName = dirs.slice(modules + 1, packageEnd).join("/");
      if (packageEnd < dirs.length && (await packageOwnsCommand(owner, packageName, realPath))) {
        keys.push(`root:${root}`);
      }
    }
    return keys;
  } catch {
    return [];
  }
}
