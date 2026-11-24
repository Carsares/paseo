import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import {
  isSensitiveEnvKey,
  openCustomProviderCliForm,
  type CustomProviderCliFormSnapshot,
} from "./custom-provider-cli-form-model";
import {
  readCustomProviderConfig,
  resolveCustomProviderEditTarget,
  type ProviderEntry,
} from "./provider-config";

function createSnapshot(
  overrides: Partial<CustomProviderCliFormSnapshot> = {},
): CustomProviderCliFormSnapshot {
  return {
    mode: "create",
    targetKind: "new",
    serverId: "host-1",
    hostLabel: "Mac Studio",
    existingProviderIds: ["claude", "codex", "antigravity", "existing-acp"],
    configLoaded: true,
    ...overrides,
  };
}

describe("custom-provider-cli-form-model", () => {
  it("requires explicit command for ACP creation, preserves argument whitespace and explicit empty args, and ignores unconfirmed blank rows", () => {
    const model = openCustomProviderCliForm(createSnapshot());

    expect(model.getState().extendsProvider).toBe("acp");
    expect(model.getState().isCommandRequired).toBe(true);
    expect(model.getState().canLocate).toBe(false);
    expect(model.getState().canTest).toBe(false);
    expect(model.getState().canSave).toBe(false);

    model.setProviderId("my-acp");
    model.setLabel("My ACP");
    expect(model.getState().errors.executable).toBe("commandRequiredForAcp");
    expect(model.getState().draft).toBeNull();

    model.setExecutable("/usr/local/bin/my-agent");
    // Unconfirmed newly added arg row must not be submitted accidentally.
    model.addArg();
    expect(model.getState().args[0].confirmed).toBe(false);
    expect(model.getState().draft).toEqual({
      mode: "create",
      providerId: "my-acp",
      extends: "acp",
      label: "My ACP",
      command: ["/usr/local/bin/my-agent"],
    });

    // Editing preserves leading and trailing spaces verbatim.
    model.setArg(model.getState().args[0].id, "  --padded value  ");
    // Adding a second row and explicitly confirming it submits an explicit empty arg "".
    model.addArg();
    model.confirmArg(model.getState().args[1].id);
    // Adding a third unconfirmed row still stays excluded.
    model.addArg();

    expect(model.getState().canLocate).toBe(true);
    expect(model.getState().canTest).toBe(true);
    expect(model.getState().canSave).toBe(true);
    expect(model.getState().draft).toEqual({
      mode: "create",
      providerId: "my-acp",
      extends: "acp",
      label: "My ACP",
      command: ["/usr/local/bin/my-agent", "  --padded value  ", ""],
    });
  });

  it("rejects invalid, reserved, and existing IDs when creating a generic ACP entry", () => {
    const model = openCustomProviderCliForm(createSnapshot());
    model.setLabel("Test");
    model.setExecutable("my-bin");

    model.setProviderId("Bad_ID");
    expect(model.getState().errors.providerId).toBe("providerIdInvalid");
    expect(model.getState().draft).toBeNull();

    for (const conflictId of [
      "claude",
      "acp",
      "antigravity",
      "existing-acp",
      "cursor",
      "kimi",
      "kiro",
      "traecli",
    ]) {
      model.setProviderId(conflictId);
      expect(model.getState().errors.providerId).toBe("providerIdConflict");
      expect(model.getState().draft).toBeNull();
    }

    model.setProviderId("fresh-cli");
    expect(model.getState().errors.providerId).toBeNull();
    expect(model.getState().draft?.providerId).toBe("fresh-cli");
  });

  it("allows omitting command when creating a provider that extends a built-in", () => {
    const model = openCustomProviderCliForm(createSnapshot());
    model.setExtends("claude", { label: "Claude" });
    model.setProviderId("claude-work");
    model.setLabel("Claude Work");

    expect(model.getState().isCommandRequired).toBe(false);
    expect(model.getState().apiKeyEnvName).toBe("ANTHROPIC_API_KEY");
    expect(model.getState().draft).toEqual({
      mode: "create",
      providerId: "claude-work",
      extends: "claude",
      label: "Claude Work",
    });

    // Adding an unconfirmed row alone does not trigger executableRequiredWithArgs.
    model.addArg();
    expect(model.getState().errors.executable).toBeNull();

    // Confirming an arg without an executable is rejected.
    const arg = model.getState().args[0];
    model.setArg(arg.id, "--verbose");
    expect(model.getState().errors.executable).toBe("executableRequiredWithArgs");
    expect(model.getState().draft).toBeNull();
  });

  it("submits only explicitly modified fields in edit mode and clears description with an empty string", () => {
    const model = openCustomProviderCliForm(
      createSnapshot({
        mode: "edit",
        targetKind: "custom",
        initialProvider: {
          providerId: "my-acp",
          extends: "acp",
          label: "Original ACP",
          description: "Old description",
          command: ["/opt/old-acp", "  --keep-spaces  ", ""],
        },
      }),
    );

    // Before any edits, edit draft omits untouched label/description/command so concurrent host edits survive.
    expect(model.getState().draft).toEqual({
      mode: "edit",
      providerId: "my-acp",
      extends: "acp",
    });

    // Adding then removing an unconfirmed arg row does not dirty command.
    model.addArg();
    const unconfirmedId = model.getState().args[2].id;
    model.removeArg(unconfirmedId);
    expect(model.getState().dirty.command).toBe(false);

    // Editing only label submits ONLY label — never old command or old description.
    model.setLabel("Renamed ACP");
    expect(model.getState().draft).toEqual({
      mode: "edit",
      providerId: "my-acp",
      extends: "acp",
      label: "Renamed ACP",
    });

    // Explicitly clearing description sends description: "" to clear it on the host.
    model.setDescription("");
    expect(model.getState().draft).toEqual({
      mode: "edit",
      providerId: "my-acp",
      extends: "acp",
      label: "Renamed ACP",
      description: "",
    });

    // Modifying command sends verbatim loaded args (spaces + explicit empty arg preserved).
    model.setExecutable("/opt/new-acp");
    expect(model.getState().draft).toEqual({
      mode: "edit",
      providerId: "my-acp",
      extends: "acp",
      label: "Renamed ACP",
      description: "",
      command: ["/opt/new-acp", "  --keep-spaces  ", ""],
    });
  });

  it("handles built-in override via edit mode without extends and locks providerId", () => {
    const model = openCustomProviderCliForm(
      createSnapshot({
        mode: "edit",
        targetKind: "builtin",
        initialProvider: {
          providerId: "claude",
          command: ["/opt/claude/bin/claude", "--flag"],
        },
      }),
    );

    expect(model.getState().showExtendsField).toBe(false);
    expect(model.getState().isProviderIdLocked).toBe(true);
    expect(model.getState().apiKeyEnvName).toBe("ANTHROPIC_API_KEY");
    expect(model.getState().apiKeyValue).toBe("");

    model.setProviderId("other-id");
    expect(model.getState().providerId).toBe("claude");

    // Untouched command is omitted until modified.
    expect(model.getState().draft).toEqual({
      mode: "edit",
      providerId: "claude",
    });

    model.setExecutable("/opt/claude-v2/claude");
    expect(model.getState().draft).toEqual({
      mode: "edit",
      providerId: "claude",
      command: ["/opt/claude-v2/claude", "--flag"],
    });
  });

  it("hydrates untouched fields on late config arrival without overwriting user input", () => {
    const model = openCustomProviderCliForm(
      createSnapshot({
        mode: "edit",
        targetKind: "custom",
        configLoaded: false,
        initialProvider: {
          providerId: "my-acp",
          extends: "acp",
          label: "Snapshot Label",
        },
      }),
    );

    expect(model.getState().isProviderIdLocked).toBe(true);
    expect(model.getState().isExtendsLocked).toBe(true);
    model.setProviderId("renamed-id");
    model.setExtends("claude");
    expect(model.getState().providerId).toBe("my-acp");
    expect(model.getState().extendsProvider).toBe("acp");

    // User edits label BEFORE late config arrives.
    model.setLabel("User Typed Label");
    const labelResetBefore = model.getState().labelResetKey;

    model.applyInitialConfig({
      providerId: "my-acp",
      extends: "acp",
      label: "Stale Config Label",
      description: "Hydrated description",
      command: ["/opt/bin/my-acp", "--stdio"],
    });

    // User's label survives and its resetKey does not reset the live input.
    expect(model.getState().label).toBe("User Typed Label");
    expect(model.getState().labelResetKey).toBe(labelResetBefore);
    // Untouched fields hydrate for display, yet stay non-dirty so only label is submitted.
    expect(model.getState().description).toBe("Hydrated description");
    expect(model.getState().executable).toBe("/opt/bin/my-acp");
    expect(model.getState().args.map((a) => a.value)).toEqual(["--stdio"]);
    expect(model.getState().draft).toEqual({
      mode: "edit",
      providerId: "my-acp",
      extends: "acp",
      label: "User Typed Label",
    });
  });

  it("keeps env write-only, rejects duplicates, and clears both inputs and draft secrets on close", () => {
    const model = openCustomProviderCliForm(createSnapshot());
    model.setExtends("codex", { label: "Codex" });
    model.setProviderId("codex-proxy");
    model.setLabel("Codex Proxy");

    expect(model.getState().apiKeyEnvName).toBe("OPENAI_API_KEY");
    expect(model.getState().draft?.env).toBeUndefined();

    model.setApiKeyValue("sk-secret-value");
    model.addEnvEntry();
    const firstEnv = model.getState().envEntries[0];
    model.setEnvKey(firstEnv.id, "OPENAI_BASE_URL");
    model.setEnvValue(firstEnv.id, "https://proxy.example.com/v1");

    expect(model.getState().draft?.env).toEqual({
      OPENAI_API_KEY: "sk-secret-value",
      OPENAI_BASE_URL: "https://proxy.example.com/v1",
    });

    // Duplicate key across API key and extra env row is rejected.
    model.addEnvEntry();
    const duplicateEnv = model.getState().envEntries[1];
    model.setEnvKey(duplicateEnv.id, "OPENAI_API_KEY");
    model.setEnvValue(duplicateEnv.id, "sk-duplicate");

    expect(model.getState().errors.env).toBe("duplicateEnvKey");
    expect(model.getState().errors.duplicateEnvKeyName).toBe("OPENAI_API_KEY");
    expect(model.getState().draft).toBeNull();

    // Remove duplicate so draft holds secrets again, then verify close wipes draft & env completely.
    model.removeEnvEntry(duplicateEnv.id);
    expect(model.getState().draft?.env?.OPENAI_API_KEY).toBe("sk-secret-value");

    expect(isSensitiveEnvKey("ANTHROPIC_API_KEY")).toBe(true);
    expect(isSensitiveEnvKey("MY_AUTH_TOKEN")).toBe(true);
    expect(isSensitiveEnvKey("OPENAI_BASE_URL")).toBe(false);

    model.close();
    expect(model.getState().draft).toBeNull();
    expect(model.getState().apiKeyValue).toBe("");
    expect(model.getState().envEntries).toEqual([]);
    expect(model.getState().canSave).toBe(false);
    expect(JSON.stringify(model.getState())).not.toContain("sk-secret-value");
  });

  it("blocks field edits and duplicate saves while a save is pending, and allows retry after failure", () => {
    const model = openCustomProviderCliForm(createSnapshot());
    model.setProviderId("my-acp");
    model.setLabel("Initial Label");
    model.setExecutable("/opt/v1/my-acp");

    const firstTicket = model.beginSave();
    expect(firstTicket).not.toBeNull();
    expect(model.getState().saveState.kind).toBe("pending");
    expect(model.getState().canSave).toBe(false);

    // Editing fields during pending save is blocked and must NOT reset saveState or permit a second save.
    model.setLabel("Edited During Save");
    model.setExecutable("/opt/v2/my-acp");
    model.addArg();
    model.setApiKeyValue("sk-during-save");
    expect(model.getState().label).toBe("Initial Label");
    expect(model.getState().executable).toBe("/opt/v1/my-acp");
    expect(model.getState().args).toEqual([]);
    expect(model.getState().apiKeyValue).toBe("");
    expect(model.getState().saveState.kind).toBe("pending");
    expect(model.beginSave()).toBeNull();

    // When the first save returns blocked with reason reload_required, preserve reason and unlock for retry.
    expect(
      model.completeSave(firstTicket!, {
        requestId: "save-reload",
        result: { status: "blocked", reason: "reload_required" },
      }),
    ).toBe(true);
    expect(model.getState().saveState).toEqual({
      kind: "result",
      status: "blocked",
      reason: "reload_required",
    });
    expect(model.getState().canSave).toBe(true);

    model.setLabel("Retried Label");
    expect(model.getState().label).toBe("Retried Label");

    // Plain blocked without reason omits reason on operation state.
    const plainBlockedTicket = model.beginSave();
    expect(
      model.completeSave(plainBlockedTicket!, {
        requestId: "save-blocked",
        result: { status: "blocked" },
      }),
    ).toBe(true);
    expect(model.getState().saveState).toEqual({ kind: "result", status: "blocked" });

    const retryTicket = model.beginSave();
    expect(retryTicket).not.toBeNull();
    expect(
      model.completeSave(retryTicket!, {
        requestId: "save-ok",
        result: { status: "ok" },
      }),
    ).toBe(true);
    expect(model.getState().saveState).toEqual({ kind: "result", status: "ok" });
  });

  it("shields stale locate, test, and save completions after draft edits or close", () => {
    const model = openCustomProviderCliForm(createSnapshot());
    model.setProviderId("my-acp");
    model.setLabel("My ACP");
    model.setExecutable("/opt/v1/my-acp");

    const locateTicket1 = model.beginLocate();
    expect(locateTicket1).not.toBeNull();

    model.setExecutable("/opt/v2/my-acp");
    expect(model.getState().locateState).toEqual({ kind: "idle" });

    expect(
      model.completeLocate(locateTicket1!, {
        requestId: "req-1",
        result: { status: "ok", path: "/opt/v1/my-acp" },
      }),
    ).toBe(false);
    expect(model.getState().locateState).toEqual({ kind: "idle" });
    expect(model.getState().resolvedPath).toBeNull();

    const locateTicket2 = model.beginLocate();
    expect(
      model.completeLocate(locateTicket2!, {
        requestId: "req-2",
        result: { status: "ok", path: "/opt/v2/my-acp" },
      }),
    ).toBe(true);
    expect(model.getState().resolvedPath).toBe("/opt/v2/my-acp");

    const testTicket = model.beginTest();
    expect(
      model.completeTest(testTicket!, {
        requestId: "req-3",
        result: null,
      }),
    ).toBe(true);
    expect(model.getState().testState).toEqual({ kind: "null_result" });

    const saveTicket = model.beginSave();
    model.close();
    expect(
      model.completeSave(saveTicket!, {
        requestId: "req-4",
        result: { status: "ok" },
      }),
    ).toBe(false);
  });
});

describe("provider-config custom CLI helpers", () => {
  it("reads metadata and command from config without exposing env values", () => {
    const config = {
      mcp: { injectIntoAgents: true },
      browserTools: { enabled: false },
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
      providers: {
        "my-acp": {
          extends: "acp",
          label: "My ACP",
          description: "Custom agent",
          command: ["/opt/my-acp", "--acp"],
          env: { SECRET_API_KEY: "super-secret-value" },
        },
      },
    } as MutableDaemonConfig;

    const read = readCustomProviderConfig(config, "my-acp");
    expect(read).toEqual({
      extends: "acp",
      label: "My ACP",
      description: "Custom agent",
      command: ["/opt/my-acp", "--acp"],
    });
    expect(JSON.stringify(read)).not.toContain("super-secret-value");
  });

  it("resolves built-in overrides and custom providers while rejecting external plugin providers", () => {
    const config = {
      mcp: { injectIntoAgents: true },
      browserTools: { enabled: false },
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
      providers: {
        claude: { command: ["/opt/claude-nightly"] },
        "my-acp": { extends: "acp", label: "My ACP", command: ["/opt/my-acp", "--acp"] },
        antigravity: { enabled: true },
      },
    } as MutableDaemonConfig;

    const builtinEntry: ProviderEntry = {
      provider: "claude",
      status: "ready",
      enabled: true,
      source: "builtin",
      label: "Claude",
    };
    expect(resolveCustomProviderEditTarget({ entry: builtinEntry, config })).toEqual({
      targetKind: "builtin",
      initialProvider: {
        providerId: "claude",
        label: undefined,
        description: undefined,
        command: ["/opt/claude-nightly"],
      },
    });

    const customAcpEntry: ProviderEntry = {
      provider: "my-acp",
      status: "ready",
      enabled: true,
      source: "custom",
      label: "My ACP",
    };
    expect(resolveCustomProviderEditTarget({ entry: customAcpEntry, config })).toEqual({
      targetKind: "custom",
      initialProvider: {
        providerId: "my-acp",
        extends: "acp",
        label: "My ACP",
        description: undefined,
        command: ["/opt/my-acp", "--acp"],
      },
    });

    // External plugin provider must never impersonate a built-in override.
    const externalPluginEntry: ProviderEntry = {
      provider: "antigravity",
      status: "ready",
      enabled: true,
      source: "custom",
      label: "Antigravity",
    };
    expect(resolveCustomProviderEditTarget({ entry: externalPluginEntry, config })).toBeNull();
  });
});
