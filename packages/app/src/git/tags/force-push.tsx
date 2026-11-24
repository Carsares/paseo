import { useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useGitP2Copy } from "../p2-copy";
import { ForceDialog } from "./repo-ref-actions";

type Client = NonNullable<ReturnType<typeof useHostRuntimeClient>>;
type PushTarget = NonNullable<Awaited<ReturnType<Client["checkoutGitPushPrepare"]>>["target"]>;
interface PushSnapshot {
  client: Client;
  request: { cwd: string; targetRepoRoot: string; expectedHeadSha: string };
  target: PushTarget;
}

export function ForcePush({
  serverId,
  cwd,
  repoRoot,
  headSha,
  branch,
  active,
  canWrite,
  onChanged,
}: {
  serverId: string;
  cwd: string;
  repoRoot: string;
  headSha: string;
  branch: string;
  active: boolean;
  canWrite: boolean;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const copy = useGitP2Copy();
  const client = useHostRuntimeClient(serverId);
  const [snapshot, setSnapshot] = useState<PushSnapshot>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [stale, setStale] = useState(false);
  const pending = useRef(false);
  const live = useRef({ client, canWrite, cwd, repoRoot, headSha, branch });
  live.current = { client, canWrite, cwd, repoRoot, headSha, branch };

  function matches(prepared: PushSnapshot) {
    const current = live.current;
    return (
      prepared.client === current.client &&
      prepared.request.cwd === current.cwd &&
      prepared.request.targetRepoRoot === current.repoRoot &&
      prepared.request.expectedHeadSha === current.headSha &&
      prepared.target.branch === current.branch
    );
  }

  async function run(action: () => Promise<void>) {
    if (pending.current || !live.current.canWrite) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  const prepare = useStableEvent(() => {
    if (!client || snapshot) return;
    const request = { cwd, targetRepoRoot: repoRoot, expectedHeadSha: headSha };
    void run(async () => {
      const response = await client.checkoutGitPushPrepare(request);
      if (response.errorCode === "STALE_REMOTE_BASELINE") throw new Error(copy.staleRemote);
      if (response.error || !response.target) throw new Error(response.error ?? copy.noUpstream);
      const prepared = { client, request, target: response.target };
      if (response.target.branch !== branch || !matches(prepared))
        throw new Error(t("gitWorkbench.stale"));
      setStale(false);
      setSnapshot(prepared);
    });
  });
  const close = useStableEvent(() => {
    setSnapshot(undefined);
    setError(undefined);
  });
  const submit = useStableEvent((confirmation: string) => {
    if (!snapshot || stale || !matches(snapshot) || confirmation !== phrase(snapshot)) return;
    void run(async () => {
      const result = await snapshot.client.checkoutGitPushForce({
        ...snapshot.request,
        expectedPushToken: snapshot.target.token,
        confirmation,
      });
      if (result.errorCode === "STALE_REMOTE_BASELINE") {
        setStale(true);
        setError(copy.staleRemote);
        await onChanged();
        return;
      }
      if (!result.success) throw new Error(result.error ?? t("gitWorkbench.failed"));
      setSnapshot(undefined);
      await onChanged();
    });
  });
  return (
    <View style={styles.container}>
      <Button
        size="sm"
        variant="ghost"
        testID="git-force-push"
        disabled={!client || !canWrite || busy || Boolean(snapshot)}
        onPress={prepare}
      >
        {busy && !snapshot ? t("common.loading") : copy.forcePush}
      </Button>
      {snapshot ? (
        <ForceDialog
          title={copy.forcePush}
          phrase={phrase(snapshot)}
          target={`${snapshot.target.remote} · ${snapshot.target.remoteRef}`}
          sha={snapshot.target.remoteSha}
          visible={active}
          busy={busy}
          ready={canWrite && !stale && matches(snapshot)}
          onClose={close}
          onConfirm={submit}
          error={matches(snapshot) ? error : t("gitWorkbench.stale")}
        />
      ) : null}
      {!snapshot && error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function phrase(snapshot: PushSnapshot) {
  return `force-push ${snapshot.target.branch}`;
}

const styles = StyleSheet.create((theme) => ({
  container: { flexShrink: 1 },
  error: { color: theme.colors.destructive },
}));
