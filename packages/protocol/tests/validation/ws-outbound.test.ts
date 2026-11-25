import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import type { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  parseServerInfoStatusPayload,
  PluginRpcInvokeResponseSchema,
  WSInboundMessageSchema,
  WSOutboundMessageSchema,
} from "../../src/messages.js";
import { validateWSOutboundMessage } from "../../src/validation/ws-outbound.js";

interface GeneratedSchema {
  safeParse(input: unknown): { success: boolean; data?: unknown };
}

const protocolRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const generatedWSOutboundPath = resolve(
  protocolRoot,
  "src/generated/validation/ws-outbound.aot.ts",
);
const require = createRequire(import.meta.url);

async function compileInlineSchema(sourceSchema: string): Promise<GeneratedSchema> {
  const scratchRoot = resolve(protocolRoot, "../../.tmp");
  await mkdir(scratchRoot, { recursive: true });
  const tempDir = await mkdtemp(join(scratchRoot, "paseo-zod-aot-"));

  try {
    const sourcePath = join(tempDir, "schema.source.js");
    const outputPath = join(tempDir, "schema.generated.ts");
    await writeFile(join(tempDir, "package.json"), '{"type":"module"}\n');
    await writeFile(
      sourcePath,
      [
        'import { z } from "zod";',
        'import { compile } from "zod-aot";',
        sourceSchema,
        "export const Schema = compile(SourceSchema);",
        "",
      ].join("\n"),
    );

    const zodAotEntry = require.resolve("zod-aot");
    const zodAotRoot = resolve(dirname(zodAotEntry), "..");
    const [{ discoverSchemas }, { compileSchemas }, { generateCompiledFileContent }] =
      await Promise.all([
        import(pathToFileURL(resolve(zodAotRoot, "dist/discovery.js")).href),
        import(pathToFileURL(resolve(zodAotRoot, "dist/core/pipeline.js")).href),
        import(pathToFileURL(resolve(zodAotRoot, "dist/cli/emitter.js")).href),
      ]);

    const schemas = await discoverSchemas(sourcePath, { cacheBust: true });
    const compiled = compileSchemas(schemas, { mode: "inline" });
    const content = generateCompiledFileContent(compiled, "./schema.source.js", {
      zodCompat: false,
    });
    await writeFile(outputPath, content);

    const jiti = createJiti(import.meta.url, { moduleCache: false });
    const generated = await jiti.import(outputPath);
    return generated.Schema as GeneratedSchema;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

describe("WS outbound zod-aot validation", () => {
  it("validates correlated workbench replies and their nested discriminated branches", () => {
    const decision = {
      type: "session",
      message: {
        type: "workspace.durable_item.decide.response",
        payload: {
          requestId: "call-1",
          durableItemRequestId: "item-1",
          workspaceId: "workspace-1",
          error: null,
          item: {
            workspaceId: "workspace-1",
            requestId: "item-1",
            sourceAgentId: "main-1",
            sourceTurnId: "turn-1",
            kind: "acceptance",
            title: "Review startup changes",
            status: "decided",
            decision: "approve",
            revision: 2,
            createdAt: "2026-11-24T00:00:00Z",
            decidedAt: "2026-11-24T01:00:00Z",
            evidence: [
              { type: "file", path: "startup-trace.md", fingerprint: "trace-1" },
              {
                type: "git",
                path: "boot.ts",
                repoRoot: "/repo",
                headSha: "abc",
                blobOrIndexFingerprint: "blob-1",
              },
            ],
          },
        },
      },
    };
    const graph = {
      type: "session",
      message: {
        type: "checkout.git.log.query.response",
        payload: {
          requestId: "graph-1",
          cwd: "/repo",
          error: null,
          commits: [],
          hasMore: false,
          nextCursor: null,
          approxBytes: 100,
        },
      },
    };
    for (const envelope of [decision, graph]) {
      expect(WSOutboundMessageSchema.parse(envelope)).toEqual(envelope);
      expect(validateWSOutboundMessage(envelope)).toMatchObject({ success: true, data: envelope });
    }
    const { item, ...payload } = decision.message.payload;
    const { decision: _choice, ...invalidItem } = item;
    const invalidDecision = {
      ...decision,
      message: { ...decision.message, payload: { ...payload, item: invalidItem } },
    };
    expect(validateWSOutboundMessage(invalidDecision).success).toBe(false);
  });

  it("preserves the Git identifiers in responses and accepts staging-only working trees", () => {
    const result = { cwd: "/repo", repoRoot: "/repo", requestId: "req-1", error: null };
    const rebaseId = "rebase:v1/b+=";
    const workingTree = {
      repoRoot: "/repo",
      headSha: "a".repeat(40),
      currentBranch: "main",
      operationState: "idle",
      staged: [],
      unstaged: [],
      untracked: [],
      conflicts: [],
      activeAgents: [],
    };
    const conflict = {
      path: "boot.ts",
      status: "UU",
      base: null,
      ours: null,
      theirs: null,
      hunks: [],
    };
    const inspect = (entry: typeof conflict & { conflictFingerprint?: string }) => ({
      type: "checkout.git.conflict.inspect.response",
      payload: { ...result, conflicts: [entry] },
    });
    for (const message of [
      inspect({ ...conflict, conflictFingerprint: "snapshot:v1/a+=" }),
      {
        type: "checkout.git.rebase.execute.response",
        payload: { ...result, success: true, rebaseId },
      },
      {
        type: "checkout.git.rebase.act.response",
        payload: { ...result, success: true, rebaseId },
      },
      ...[workingTree, { ...workingTree, operationState: "rebase_paused", rebaseId }].map(
        (tree) => ({
          type: "checkout.git.working_tree.get.response",
          payload: { ...result, workingTree: tree },
        }),
      ),
      {
        type: "checkout_commit_response",
        payload: { cwd: "/repo", requestId: "legacy-1", success: true, error: null },
      },
    ]) {
      const envelope = { type: "session", message };
      expect(validateWSOutboundMessage(envelope)).toMatchObject({ success: true, data: envelope });
    }
    for (const message of [
      inspect(conflict),
      inspect({ ...conflict, conflictFingerprint: "" }),
      {
        type: "checkout.git.rebase.execute.response",
        payload: { ...result, success: true },
      },
      {
        type: "checkout.git.rebase.act.response",
        payload: { ...result, success: true, rebaseId: "" },
      },
    ]) {
      expect(validateWSOutboundMessage({ type: "session", message }).success).toBe(false);
    }
  });

  it("applies defaults inside discriminated-union branches", async () => {
    const schema = await compileInlineSchema(`
const SourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("with_default"),
    enabled: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("without_default"),
    label: z.string(),
  }),
]);
`);

    expect(schema.safeParse({ type: "with_default" })).toMatchObject({
      success: true,
      data: { type: "with_default", enabled: true },
    });
  });

  it("routes tool-call-like status unions through the current sequential item union", async () => {
    const schema = await compileInlineSchema(`
const ToolCallItemSchema = z.discriminatedUnion("status", [
  z.object({ type: z.literal("tool_call"), status: z.literal("running"), callId: z.string() }),
  z.object({ type: z.literal("tool_call"), status: z.literal("completed"), callId: z.string(), output: z.string() }),
  z.object({ type: z.literal("tool_call"), status: z.literal("failed"), callId: z.string(), error: z.string() }),
  z.object({ type: z.literal("tool_call"), status: z.literal("canceled"), callId: z.string() }),
]);

const TimelineItemSchema = z.union([
  z.object({ type: z.literal("assistant_message"), text: z.string() }),
  ToolCallItemSchema,
]);

const SourceSchema = z.object({
  item: TimelineItemSchema,
});
`);

    expect(
      schema.safeParse({ item: { type: "tool_call", status: "running", callId: "run" } }),
    ).toMatchObject({
      success: true,
      data: { item: { type: "tool_call", status: "running", callId: "run" } },
    });
    expect(
      schema.safeParse({
        item: { type: "tool_call", status: "completed", callId: "done", output: "ok" },
      }),
    ).toMatchObject({
      success: true,
      data: { item: { type: "tool_call", status: "completed", callId: "done", output: "ok" } },
    });
    expect(
      schema.safeParse({
        item: { type: "tool_call", status: "failed", callId: "fail", error: "boom" },
      }),
    ).toMatchObject({
      success: true,
      data: { item: { type: "tool_call", status: "failed", callId: "fail", error: "boom" } },
    });
    expect(
      schema.safeParse({ item: { type: "tool_call", status: "canceled", callId: "stop" } }),
    ).toMatchObject({
      success: true,
      data: { item: { type: "tool_call", status: "canceled", callId: "stop" } },
    });
  });

  it("accepts a minimal valid envelope and rejects a corrupted envelope", () => {
    expect(validateWSOutboundMessage({ type: "pong" }).success).toBe(true);
    expect(validateWSOutboundMessage({ type: "not_a_message" }).success).toBe(false);
  });

  it("validates both directions of the inbox flush RPC", () => {
    const request = {
      type: "session",
      message: { type: "agent.inbox.flush.request", agentId: "parent", requestId: "flush-1" },
    };
    expect(WSInboundMessageSchema.parse(request)).toEqual(request);
    expect(
      WSInboundMessageSchema.safeParse({
        ...request,
        message: { ...request.message, agentId: null },
      }).success,
    ).toBe(false);

    const response = {
      type: "session",
      message: {
        type: "agent.inbox.flush.response",
        payload: { agentId: "parent", requestId: "flush-1", success: true, error: null },
      },
    };
    expect(validateWSOutboundMessage(response)).toEqual({ success: true, data: response });
    expect(
      validateWSOutboundMessage({
        ...response,
        message: {
          ...response.message,
          payload: { ...response.message.payload, error: undefined },
        },
      }).success,
    ).toBe(false);
  });

  it.each([undefined, "completed", "blocked", "invalid"])(
    "validates agent message provenance with report status %s on timeline events",
    (reportStatus) => {
      const envelope = {
        type: "session",
        message: {
          type: "agent_stream",
          payload: {
            agentId: "parent",
            timestamp: "2026-11-23T00:00:00.000Z",
            event: {
              type: "timeline",
              provider: "claude",
              item: {
                type: "tool_call",
                name: "send_agent_message",
                callId: "report-1",
                status: "completed",
                error: null,
                detail: { type: "plain_text", text: "Report" },
                agentMessage: {
                  event: "finished",
                  sender: { id: "child" },
                  text: "Report",
                  ...(reportStatus === undefined ? {} : { reportStatus }),
                },
              },
            },
          },
        },
      };
      const result = validateWSOutboundMessage(envelope);
      if (reportStatus === "invalid") expect(result.success).toBe(false);
      else expect(result).toEqual({ success: true, data: envelope });
    },
  );

  it("accepts hosts with or without the Main Control system prompt capability", () => {
    const payload = { status: "server_info", serverId: "host", features: { agentProfiles: true } };
    expect(parseServerInfoStatusPayload(payload)?.features).toEqual({ agentProfiles: true });
    for (const supported of [true, false]) {
      const features = { ...payload.features, mainControlAppendSystemPrompt: supported };
      expect(parseServerInfoStatusPayload({ ...payload, features })?.features).toEqual(features);
    }
    expect(
      parseServerInfoStatusPayload({
        ...payload,
        features: { mainControlAppendSystemPrompt: "true" },
      }),
    ).toBeNull();
  });

  it("preserves an empty Main Control system prompt and rejects non-string config values", () => {
    const envelope = (config: unknown) => ({
      type: "session",
      message: { type: "get_daemon_config_response", payload: { requestId: "config", config } },
    });
    const config = { mcp: { injectIntoAgents: true } };
    expect(validateWSOutboundMessage(envelope(config)).success).toBe(true);
    expect(
      validateWSOutboundMessage(envelope({ ...config, mainControlAppendSystemPrompt: "" })),
    ).toMatchObject({
      success: true,
      data: { message: { payload: { config: { mainControlAppendSystemPrompt: "" } } } },
    });
    expect(
      validateWSOutboundMessage(envelope({ ...config, mainControlAppendSystemPrompt: true }))
        .success,
    ).toBe(false);
  });

  it("accepts explicit empty prompt patches and patches from existing clients", () => {
    const asRequest = (config: unknown) => ({
      type: "session",
      message: { type: "set_daemon_config_request", requestId: "patch", config },
    });
    for (const config of [
      { appendSystemPrompt: "Existing client" },
      { mainControlAppendSystemPrompt: "" },
    ]) {
      const request = asRequest(config);
      expect(WSInboundMessageSchema.parse(request)).toEqual(request);
    }
    expect(
      WSInboundMessageSchema.safeParse(asRequest({ mainControlAppendSystemPrompt: false })).success,
    ).toBe(false);
  });

  it("validates a workspace summary with a text attachment", () => {
    const envelope = {
      type: "session",
      message: {
        type: "workspace.agents.summary.response",
        payload: {
          workspaceId: "wks_1234567890abcdef",
          requestId: "summary",
          summaryText: "Work finished",
          attachment: { type: "text", mimeType: "text/plain", text: "Work finished" },
          entries: [],
          error: null,
        },
      },
    };
    expect(validateWSOutboundMessage(envelope)).toEqual({ success: true, data: envelope });
    expect(
      validateWSOutboundMessage({
        ...envelope,
        message: {
          ...envelope.message,
          payload: {
            ...envelope.message.payload,
            attachment: { ...envelope.message.payload.attachment, text: 123 },
          },
        },
      }).success,
    ).toBe(false);
  });

  it("accepts project config responses with and without setup commit status", () => {
    const payload = {
      requestId: "project-config-read",
      repoRoot: "/repo",
      ok: true,
      config: null,
      revision: null,
    };
    const envelope = (
      responsePayload: typeof payload & {
        hasUncommittedWorktreeSetupChanges?: boolean;
      },
    ) => ({
      type: "session",
      message: {
        type: "read_project_config_response",
        payload: responsePayload,
      },
    });

    expect(validateWSOutboundMessage(envelope(payload)).success).toBe(true);
    expect(
      validateWSOutboundMessage(envelope({ ...payload, hasUncommittedWorktreeSetupChanges: true }))
        .success,
    ).toBe(true);
  });

  it("accepts a compact provider snapshot envelope", () => {
    const envelope = {
      type: "session",
      message: {
        type: "get_providers_snapshot_response",
        payload: {
          entries: [],
          compactSnapshot: {
            entries: [
              {
                provider: "pi",
                status: "ready",
                enabled: true,
                models: [{ id: "model-a", label: "Model A", thinkingSet: 0 }],
              },
            ],
            thinkingSets: [
              {
                options: [{ id: "high", label: "High", isDefault: true }],
                defaultOptionId: "high",
              },
            ],
          },
          snapshotHash: "snapshot-hash",
          generatedAt: "2026-08-04T00:00:00.000Z",
          requestId: "provider-snapshot",
        },
      },
    };

    expect(validateWSOutboundMessage(envelope)).toEqual({
      success: true,
      data: envelope,
    });
  });

  it.each([
    {
      name: "dedicated attention message",
      message: {
        type: "agent_attention_required",
        payload: {
          agentId: "agent-1",
          reason: "finished",
          timestamp: "2026-07-22T18:00:00.000Z",
          shouldNotify: true,
          notification: {
            title: "Agent finished",
            body: "Done",
            data: {
              serverId: "server-1",
              workspaceId: "workspace-1",
              agentId: "agent-1",
              reason: "finished",
            },
          },
        },
      },
    },
    {
      name: "agent stream attention event",
      message: {
        type: "agent_stream",
        payload: {
          agentId: "agent-1",
          timestamp: "2026-07-22T18:00:00.000Z",
          event: {
            type: "attention_required",
            provider: "codex",
            reason: "finished",
            timestamp: "2026-07-22T18:00:00.000Z",
            shouldNotify: true,
            notification: {
              title: "Agent finished",
              body: "Done",
              data: {
                serverId: "server-1",
                workspaceId: "workspace-1",
                agentId: "agent-1",
                reason: "finished",
              },
            },
          },
        },
      },
    },
  ])("preserves workspaceId in a $name", ({ message }) => {
    const envelope = { type: "session", message };

    expect(validateWSOutboundMessage(envelope)).toEqual({
      success: true,
      data: envelope,
    });
  });

  it("preserves turn metrics on a completed turn and on its timeline row", () => {
    const metrics = [
      { label: "Model", value: "gpt-5.5" },
      { label: "Cache", value: "82%", tone: "ok" },
    ];
    const completed = {
      type: "session",
      message: {
        type: "agent_stream",
        payload: {
          agentId: "agent-1",
          event: { type: "turn_completed", provider: "codex", turnId: "turn-1", metrics },
          timestamp: "2026-11-22T00:00:00.000Z",
        },
      },
    };
    const timeline = {
      type: "session",
      message: {
        type: "fetch_agent_timeline_response",
        payload: {
          requestId: "timeline",
          agentId: "agent-1",
          agent: null,
          direction: "tail",
          projection: "projected",
          epoch: "epoch-1",
          reset: false,
          staleCursor: false,
          gap: false,
          window: { minSeq: 1, maxSeq: 1, nextSeq: 2 },
          startCursor: null,
          endCursor: null,
          hasOlder: false,
          hasNewer: false,
          entries: [
            {
              provider: "codex",
              item: { type: "assistant_message", text: "Done" },
              timestamp: "2026-11-22T00:00:00.000Z",
              seqStart: 1,
              seqEnd: 1,
              sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
              collapsed: [],
              turnMetrics: metrics,
            },
          ],
          error: null,
        },
      },
    };

    expect(validateWSOutboundMessage(completed)).toEqual({ success: true, data: completed });
    expect(validateWSOutboundMessage(timeline)).toEqual({ success: true, data: timeline });
  });

  it("emits runtime imports with .js extensions", async () => {
    const generated = await readFile(generatedWSOutboundPath, "utf8");
    expect(generated).toContain('from "./ws-outbound-schema-metadata.js"');
  });

  it("accepts a forge.search.response envelope", () => {
    const result = validateWSOutboundMessage({
      type: "session",
      message: {
        type: "forge.search.response",
        payload: {
          items: [
            {
              kind: "change_request",
              number: 17,
              title: "Fix search",
              url: "https://gitlab.com/acme/repo/-/merge_requests/17",
              state: "open",
              body: null,
              labels: [],
            },
          ],
          authState: "authenticated",
          error: null,
          requestId: "search-forge",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a legacy github_search_response envelope", () => {
    const result = validateWSOutboundMessage({
      type: "session",
      message: {
        type: "github_search_response",
        payload: {
          items: [
            {
              kind: "pr",
              number: 42,
              title: "Legacy PR",
              url: "https://github.com/acme/repo/pull/42",
              state: "open",
              body: null,
              labels: [],
            },
          ],
          featuresEnabled: true,
          githubFeaturesEnabled: true,
          authState: "authenticated",
          error: null,
          requestId: "search-github",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("keeps each generated validator function small", async () => {
    // A single function for the whole protocol made V8's Maglev tier spend ~800 MB and seconds compiling it.
    const generated = await readFile(generatedWSOutboundPath, "utf8");
    const starts = [...generated.matchAll(/function safeParse_\w+\(/g)].map((match) => match.index);
    const sizes = starts.map((start, index) => (starts[index + 1] ?? generated.length) - start);

    expect(Math.max(...sizes)).toBeLessThan(1_000_000);
    expect(sizes.length).toBeGreaterThan(1);
  });

  it("keeps nested union issue paths rooted at the envelope", () => {
    // Generated validators root branch issues at the input; runtime Zod reports them relative to the union.
    const envelope = {
      type: "session",
      message: {
        type: "read_project_config_response",
        payload: { repoRoot: "/repo", ok: true, config: {}, revision: { mtimeMs: 1, size: 1 } },
      },
    };
    const paths = (issues: z.core.$ZodIssue[]): PropertyKey[][] =>
      issues.flatMap((issue) => [
        issue.path,
        ...(issue.code === "invalid_union" ? paths(issue.errors.flat()) : []),
      ]);

    const result = validateWSOutboundMessage(envelope);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(paths(result.error.issues)).toEqual([
      ["message", "payload"],
      ["message", "payload", "requestId"],
      ["message", "payload", "requestId"],
      ["message", "payload", "ok"],
      ["message", "payload", "error"],
    ]);
  });

  it.each([
    { name: "a legacy agent", inbox: {} },
    {
      name: "an agent with a pending subagent inbox",
      inbox: {
        pendingSubagentInbox: {
          count: 2,
          items: [
            { agentId: "child-1", event: "message" },
            {
              agentId: "child-2",
              serverId: "host-2",
              title: "Remote child",
              event: "finished",
              reportStatus: "blocked",
            },
          ],
        },
      },
    },
  ])("validates $name in an agent broadcast and applies defaults", ({ inbox }) => {
    const envelope = {
      type: "session",
      message: {
        type: "agent_update",
        payload: {
          kind: "upsert",
          agent: {
            id: "agent-1",
            provider: "claude",
            cwd: "/repo",
            model: "model",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            lastUserMessageAt: "2026-01-01T00:00:00.000Z",
            status: "initializing",
            capabilities: {
              supportsStreaming: false,
              supportsSessionPersistence: false,
              supportsDynamicModes: false,
              supportsMcpServers: false,
              supportsReasoningStream: false,
              supportsToolInvocations: false,
            },
            currentModeId: "default",
            availableModes: [],
            pendingPermissions: [],
            persistence: { provider: "claude", sessionId: "session-1" },
            title: "Agent",
            ...inbox,
          },
        },
      },
    };

    const result = validateWSOutboundMessage(envelope);
    const expected = WSOutboundMessageSchema.safeParse(envelope);

    expect(expected.success).toBe(true);
    expect(result).toEqual(expected);
    expect(result.success && result.data).toMatchObject({
      message: {
        payload: { agent: { capabilities: { supportsRewindConversation: false }, ...inbox } },
      },
    });
  });
});

it("accepts omitted RPC output so the receiving client can apply schema defaults", () => {
  const message = { type: "plugin.rpc.invoke.response", payload: { requestId: "default-output" } };
  expect(PluginRpcInvokeResponseSchema.safeParse(message).success).toBe(true);
});
