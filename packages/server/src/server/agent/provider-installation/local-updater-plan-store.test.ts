import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import { hasTrustedMacOSAcls, supportsHostApprovedProviderUpdates } from "./installation-target.js";
import {
  LOCAL_UPDATER_PLANS_FILENAME,
  MAX_LOCAL_UPDATER_PLANS_FILE_BYTES,
  formatApprovedProviderUpdaterPlansJson,
  readApprovedProviderUpdater,
  type LocalFileIdentity,
} from "./local-updater-plan-store.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) };
});

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function identity(filePath: string): Promise<LocalFileIdentity> {
  const value = await stat(filePath, { bigint: true });
  return {
    dev: value.dev.toString(),
    ino: value.ino.toString(),
    mode: Number(value.mode & 0o7777n),
    uid: Number(value.uid),
    gid: Number(value.gid),
    size: value.size.toString(),
    mtimeNs: value.mtimeNs.toString(),
    ctimeNs: value.ctimeNs.toString(),
  };
}

async function writePlan(
  paseoHome: string,
  launchPath: string,
  updaterPath: string,
  evidencePath: string,
): Promise<void> {
  const plan = {
    version: 1,
    plans: [
      {
        planId: "plan-1",
        provider: "custom-provider",
        completion: "foreground" as const,
        launchPath,
        launchIdentity: await identity(launchPath),
        updater: {
          command: updaterPath,
          identity: await identity(updaterPath),
          args: ["upgrade", "custom-provider"],
        },
        evidence: [{ path: evidencePath, identity: await identity(evidencePath) }],
      },
    ],
  };
  await writeFile(
    path.join(paseoHome, LOCAL_UPDATER_PLANS_FILENAME),
    formatApprovedProviderUpdaterPlansJson(plan.plans),
    { mode: 0o600 },
  );
}

async function createFixture(): Promise<{
  paseoHome: string;
  launchPath: string;
  updaterPath: string;
  evidencePath: string;
}> {
  const paseoHome = await temporaryDirectory("paseo-approved-plans-home-");
  const hostInstall = await temporaryDirectory("paseo-approved-plans-host-");
  const launchPath = path.join(hostInstall, "provider");
  const updaterPath = path.join(hostInstall, "package-manager");
  const evidencePath = path.join(hostInstall, "package.json");
  await writeFile(launchPath, "#!/bin/sh\n", { mode: 0o700 });
  await writeFile(updaterPath, "#!/bin/sh\n", { mode: 0o700 });
  await writeFile(evidencePath, "{}", { mode: 0o600 });
  await writePlan(paseoHome, launchPath, updaterPath, evidencePath);
  return { paseoHome, launchPath, updaterPath, evidencePath };
}

const signal = () => new AbortController().signal;
const execFileAsync = promisify(execFile);

// Run the unsupported-platform check on both real Linux and a macOS worker simulating Linux.
test.skipIf(typeof process.getuid !== "function")(
  "does not touch the plan or launch on Linux",
  async () => {
    const fixture = await createFixture();
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.mocked(lstat).mockClear();
    vi.mocked(open).mockClear();
    try {
      const input = { ...fixture, provider: "custom-provider", signal: signal() };
      await expect(readApprovedProviderUpdater(input)).resolves.toEqual([]);
      await expect(readApprovedProviderUpdater({ ...input, planId: "plan-1" })).resolves.toBeNull();
      expect(lstat).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  },
);

describe.skipIf(!supportsHostApprovedProviderUpdates())(
  "readApprovedProviderUpdater on macOS",
  () => {
    test("does not inspect the launch or approval file if real and effective user IDs differ", async () => {
      const fixture = await createFixture();
      const getuid = vi.spyOn(process, "getuid").mockReturnValue(process.geteuid!() + 1);
      vi.mocked(lstat).mockClear();
      vi.mocked(open).mockClear();
      try {
        const input = { ...fixture, provider: "custom-provider", signal: signal() };
        await expect(readApprovedProviderUpdater(input)).resolves.toEqual([]);
        await expect(
          readApprovedProviderUpdater({ ...input, planId: "plan-1" }),
        ).resolves.toBeNull();
        expect(lstat).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
      } finally {
        getuid.mockRestore();
      }
    });

    test("returns a verified fixed plan and only a summary without planId", async () => {
      const fixture = await createFixture();

      await expect(
        readApprovedProviderUpdater({
          ...fixture,
          provider: "custom-provider",
          signal: signal(),
        }),
      ).resolves.toEqual([
        { planId: "plan-1", provider: "custom-provider", launchPath: fixture.launchPath },
      ]);

      const plan = await readApprovedProviderUpdater({
        ...fixture,
        provider: "custom-provider",
        planId: "plan-1",
        signal: signal(),
      });
      expect(plan).toMatchObject({
        planId: "plan-1",
        provider: "custom-provider",
        completion: "foreground",
        launchPath: fixture.launchPath,
        updater: {
          command: fixture.updaterPath,
          resolvedCommand: await realpath(fixture.updaterPath),
          args: ["upgrade", "custom-provider"],
        },
        evidence: [{ path: fixture.evidencePath }],
      });
      expect(Object.isFrozen(plan)).toBe(true);
      expect(Object.isFrozen(plan?.updater)).toBe(true);
    });

    test.each([
      { label: "missing", completion: undefined },
      { label: "background", completion: "background" },
    ])("rejects a plan with a $label completion declaration", async ({ completion }) => {
      const fixture = await createFixture();
      const approvalPath = path.join(fixture.paseoHome, LOCAL_UPDATER_PLANS_FILENAME);
      const stored = JSON.parse(await readFile(approvalPath, "utf8"));
      stored.plans[0].completion = completion;
      await writeFile(approvalPath, JSON.stringify(stored));

      const input = { ...fixture, provider: "custom-provider", signal: signal() };
      await expect(readApprovedProviderUpdater(input)).resolves.toEqual([]);
      await expect(readApprovedProviderUpdater({ ...input, planId: "plan-1" })).resolves.toBeNull();
    });

    test("returns the checked canonical command through trusted directory and file links", async () => {
      const fixture = await createFixture();
      const hostInstall = path.dirname(fixture.updaterPath);
      const links = await mkdtemp("/tmp/paseo-approved-plan-links-");
      roots.push(links);
      await symlink(hostInstall, path.join(links, "install"));
      await symlink(fixture.paseoHome, path.join(links, "approval"));
      await symlink(path.basename(fixture.updaterPath), path.join(hostInstall, "updater-link"));
      const updaterAlias = path.join(links, "install", "updater-link");
      await writePlan(fixture.paseoHome, fixture.launchPath, updaterAlias, fixture.evidencePath);

      await expect(
        readApprovedProviderUpdater({
          ...fixture,
          paseoHome: path.join(links, "approval"),
          provider: "custom-provider",
          planId: "plan-1",
          signal: signal(),
        }),
      ).resolves.toMatchObject({
        updater: { command: updaterAlias, resolvedCommand: await realpath(fixture.updaterPath) },
      });
    });

    test.each([
      ["approval file", "file", "allow"],
      ["approval directory", "directory", "allow"],
      ["launch file", "file", "allow"],
      ["launch ancestor", "directory", "allow"],
      ["launch symlink", "link", "allow"],
      ["updater", "file", "allow"],
      ["evidence", "file", "allow"],
      ["launch symlink", "link", "deny"],
      ["approval directory", "directory", "deny"],
    ] as const)("checks a macOS %s ACL (%s, %s)", async (role, kind, action) => {
      const fixture = await createFixture();
      const { paseoHome, updaterPath, evidencePath } = fixture;
      let { launchPath } = fixture;
      const host = path.dirname(launchPath);
      const ancestor = path.join(await temporaryDirectory("paseo-approval-alias-"), "install");
      await mkdir(ancestor, { mode: 0o700 });
      if (role === "launch symlink" || role === "launch ancestor") {
        const alias = path.join(ancestor, "provider-link");
        await symlink(launchPath, alias);
        launchPath = alias;
      }
      const target = {
        "approval file": path.join(paseoHome, LOCAL_UPDATER_PLANS_FILENAME),
        "approval directory": paseoHome,
        "launch file": path.join(host, "provider"),
        "launch ancestor": ancestor,
        "launch symlink": launchPath,
        updater: updaterPath,
        evidence: evidencePath,
      }[role];
      // Capture identities after applying ACLs so a rejection proves the ACL check.
      const flags = kind === "link" ? ["-h"] : [];
      const permission = action === "allow" ? "writesecurity" : "delete";
      await execFileAsync("/bin/chmod", [
        ...flags,
        "+a",
        `everyone ${action} ${permission}`,
        target,
      ]);
      try {
        await writePlan(paseoHome, launchPath, updaterPath, evidencePath);
        const input = { paseoHome, launchPath, provider: "custom-provider", signal: signal() };
        if (action === "allow") {
          await expect(readApprovedProviderUpdater(input)).resolves.toEqual([]);
          await expect(
            readApprovedProviderUpdater({ ...input, planId: "plan-1" }),
          ).resolves.toBeNull();
        } else {
          await expect(readApprovedProviderUpdater(input)).resolves.toHaveLength(1);
          await expect(
            readApprovedProviderUpdater({ ...input, planId: "plan-1" }),
          ).resolves.toMatchObject({
            planId: "plan-1",
          });
        }
      } finally {
        await execFileAsync("/bin/chmod", [...flags, "-N", target]);
      }
    });

    test("does not interpret a missing path as having no ACL", async () => {
      const root = await temporaryDirectory("paseo-missing-acl-");
      await expect(hasTrustedMacOSAcls([root], signal())).resolves.toBe(true);
      await expect(hasTrustedMacOSAcls([root, path.join(root, "missing")], signal())).resolves.toBe(
        false,
      );
    });

    test.each(["approval directory", "launch path", "updater", "evidence"] as const)(
      "rejects a writable ancestor of the %s even if the destination is trusted",
      async (role) => {
        const fixture = await createFixture();
        const shared = await temporaryDirectory("paseo-untrusted-plan-parent-");
        const alias = path.join(shared, "alias");
        const { paseoHome, launchPath, updaterPath, evidencePath } = fixture;
        await symlink(role === "approval directory" ? paseoHome : path.dirname(updaterPath), alias);
        await chmod(shared, 0o777);
        const paths = {
          paseoHome: role === "approval directory" ? alias : paseoHome,
          launchPath:
            role === "launch path" ? path.join(alias, path.basename(launchPath)) : launchPath,
          updaterPath:
            role === "updater" ? path.join(alias, path.basename(updaterPath)) : updaterPath,
          evidencePath:
            role === "evidence" ? path.join(alias, path.basename(evidencePath)) : evidencePath,
        };
        await writePlan(paseoHome, paths.launchPath, paths.updaterPath, paths.evidencePath);

        const input = { ...paths, provider: "custom-provider", signal: signal() };
        await expect(readApprovedProviderUpdater(input)).resolves.toEqual([]);
        await expect(
          readApprovedProviderUpdater({ ...input, planId: "plan-1" }),
        ).resolves.toBeNull();
      },
    );

    test("accepts a secure host install path outside paseoHome", async () => {
      const fixture = await createFixture();
      expect(
        await readApprovedProviderUpdater({
          ...fixture,
          provider: "custom-provider",
          planId: "plan-1",
          signal: signal(),
        }),
      ).not.toBeNull();
    });

    test.each([
      ["launchPath", "launchPath", 0o700],
      ["updater", "updaterPath", 0o700],
      ["evidence", "evidencePath", 0o600],
    ] as const)("rejects a stale %s identity", async (_name, pathKey, mode) => {
      const fixture = await createFixture();
      await writeFile(fixture[pathKey], "changed", { mode });
      await expect(
        readApprovedProviderUpdater({
          ...fixture,
          provider: "custom-provider",
          planId: "plan-1",
          signal: signal(),
        }),
      ).resolves.toBeNull();
    });

    test("rejects an approval file readable by group or other users", async () => {
      const fixture = await createFixture();
      await chmod(path.join(fixture.paseoHome, LOCAL_UPDATER_PLANS_FILENAME), 0o644);
      await expect(
        readApprovedProviderUpdater({
          ...fixture,
          provider: "custom-provider",
          planId: "plan-1",
          signal: signal(),
        }),
      ).resolves.toBeNull();
    });

    test("rejects a shell interpreter as the approved updater", async () => {
      const fixture = await createFixture();
      const shellPath = path.join(path.dirname(fixture.updaterPath), "sh");
      await writeFile(shellPath, "#!/bin/sh\n", { mode: 0o700 });
      const plan = {
        planId: "plan-1",
        provider: "custom-provider",
        completion: "foreground" as const,
        launchPath: fixture.launchPath,
        launchIdentity: await identity(fixture.launchPath),
        updater: {
          command: shellPath,
          identity: await identity(shellPath),
          args: ["-c", "echo unsafe"],
        },
        evidence: [{ path: fixture.evidencePath, identity: await identity(fixture.evidencePath) }],
      };
      expect(() => formatApprovedProviderUpdaterPlansJson([plan])).toThrow();
    });

    test("rejects an updater link whose real file is a shell interpreter", async () => {
      const fixture = await createFixture();
      const shellPath = path.join(path.dirname(fixture.updaterPath), "sh");
      const updaterLink = path.join(path.dirname(fixture.updaterPath), "approved-updater");
      await writeFile(shellPath, "#!/bin/sh\n", { mode: 0o700 });
      await symlink(shellPath, updaterLink);
      await writePlan(fixture.paseoHome, fixture.launchPath, updaterLink, fixture.evidencePath);
      await expect(
        readApprovedProviderUpdater({
          ...fixture,
          provider: "custom-provider",
          planId: "plan-1",
          signal: signal(),
        }),
      ).resolves.toBeNull();
    });

    test("bounds the plan file before parsing it", async () => {
      const fixture = await createFixture();
      await writeFile(
        path.join(fixture.paseoHome, LOCAL_UPDATER_PLANS_FILENAME),
        `{"version":1,"plans":[],"extra":"${"x".repeat(MAX_LOCAL_UPDATER_PLANS_FILE_BYTES)}"}`,
        { mode: 0o600 },
      );
      await expect(
        readApprovedProviderUpdater({
          ...fixture,
          provider: "custom-provider",
          planId: "plan-1",
          signal: signal(),
        }),
      ).resolves.toBeNull();
    });

    test("returns no approval for a different provider or launch path", async () => {
      const fixture = await createFixture();
      await expect(
        readApprovedProviderUpdater({
          ...fixture,
          provider: "other-provider",
          planId: "plan-1",
          signal: signal(),
        }),
      ).resolves.toBeNull();
      await expect(
        readApprovedProviderUpdater({
          ...fixture,
          provider: "custom-provider",
          planId: "plan-1",
          launchPath: path.join(path.dirname(fixture.launchPath), "missing"),
          signal: signal(),
        }),
      ).resolves.toBeNull();
    });

    test("honors cancellation", async () => {
      const fixture = await createFixture();
      const controller = new AbortController();
      controller.abort(new Error("cancelled"));
      await expect(
        readApprovedProviderUpdater({
          ...fixture,
          provider: "custom-provider",
          planId: "plan-1",
          signal: controller.signal,
        }),
      ).rejects.toThrow("cancelled");
    });

    test("does not create the approval file or its directory", async () => {
      const paseoHome = await temporaryDirectory("paseo-approved-plans-empty-");
      await rm(path.join(paseoHome, LOCAL_UPDATER_PLANS_FILENAME), { force: true });
      const launchPath = path.join(paseoHome, "missing");
      await expect(
        readApprovedProviderUpdater({
          paseoHome,
          provider: "custom-provider",
          launchPath,
          signal: signal(),
        }),
      ).resolves.toEqual([]);
      await expect(
        readFile(path.join(paseoHome, LOCAL_UPDATER_PLANS_FILENAME)),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  },
);
