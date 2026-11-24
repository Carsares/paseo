import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { CheckoutGitWorkingTree } from "@getpaseo/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { SelectField } from "@/components/ui/select-field";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { useStableEvent } from "@/hooks/use-stable-event";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useGitP2Copy } from "../p2-copy";

type Client = NonNullable<ReturnType<typeof useHostRuntimeClient>>;
type Refs = Awaited<ReturnType<Client["checkoutGitRefsList"]>>["refs"][number];
type Ref = Refs["tags"][number];
interface ForceAction {
  ref: Ref;
  headSha: string;
  client: Client | null;
}
interface PushTagSnapshot {
  tag: Ref;
  headSha: string | null;
  client: Client | null;
}

type TagAction =
  | { action: "create"; tagName: string }
  | { action: "delete"; tag: Ref }
  | ({ action: "push"; remote: string } & PushTagSnapshot);

export function RepoRefActions({
  serverId,
  cwd,
  tree,
  active,
  connected,
  canWrite,
  onChanged,
}: {
  serverId: string;
  cwd: string;
  tree: CheckoutGitWorkingTree;
  active: boolean;
  connected: boolean;
  canWrite: boolean;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const copy = useGitP2Copy();
  const client = useHostRuntimeClient(serverId);
  const [tagName, setTagName] = useState("");
  const tagInput = useRef<EditingTextInputHandle>(null);
  const [tagToPush, setTagToPush] = useState<PushTagSnapshot>();
  const [force, setForce] = useState<ForceAction>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const busyRef = useRef(false);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const target = { cwd, targetRepoRoot: tree.repoRoot };
  const { refs, ready, loadingRefs } = useRepoRefs({
    serverId,
    cwd,
    tree,
    client,
    active,
    connected,
    canWrite,
  });
  const live = useRef({ tree, client, ready, refs: refs.data });
  live.current = { tree, client, ready, refs: refs.data };
  const remoteNames = useMemo(() => refs.data?.remotes.map(({ name }) => name) ?? [], [refs.data]);

  async function write(run: () => Promise<boolean>) {
    if (busyRef.current || !live.current.ready) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(undefined);
    try {
      if (!(await run())) return;
      setNotice({ text: t("gitWorkbench.saved"), error: false });
    } catch (cause) {
      setNotice({ text: cause instanceof Error ? cause.message : String(cause), error: true });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function refresh() {
    await Promise.all([onChanged(), refs.refetch()]);
  }

  const mutateTag = useStableEvent((command: TagAction) => {
    const headSha = command.action === "push" ? command.headSha : tree.headSha;
    const reviewedClient = command.action === "push" ? command.client : client;
    return write(async () => {
      if (command.action === "delete") {
        const approved = await confirmDialog({
          title: copy.deleteTag,
          message: `${command.tag.name}\n${command.tag.objectSha}`,
          destructive: true,
          confirmLabel: t("gitWorkbench.confirm"),
          cancelLabel: t("common.actions.cancel"),
        });
        if (!approved) return false;
      }
      const current = live.current;
      if (!mounted.current) return false;
      if (
        !current.ready ||
        !current.client ||
        current.client !== reviewedClient ||
        current.tree.headSha !== headSha
      )
        throw new Error(t("gitWorkbench.stale"));
      if (!matchesTagSelection(command, current.refs)) throw new Error(t("gitWorkbench.stale"));

      const response = await current.client
        .checkoutGitTagMutate({
          ...target,
          action: command.action,
          tagName: command.action === "create" ? command.tagName : command.tag.name,
          expectedHeadSha: headSha,
          ...(command.action !== "create" ? { expectedTagSha: command.tag.objectSha } : {}),
          ...(command.action === "push" ? { remote: command.remote } : {}),
        })
        .finally(refresh);
      if (!response.success) throw new Error(response.error ?? t("gitWorkbench.failed"));
      if (command.action === "create") {
        tagInput.current?.reset();
        setTagName("");
      }
      if (command.action === "push") setTagToPush(undefined);
      return true;
    });
  });

  const mutateForced = useStableEvent((command: ForceAction, typed: string) => {
    return write(async () => {
      if (typed !== forcePhrase(command)) return false;
      const current = live.current;
      if (
        !current.ready ||
        !current.client ||
        current.client !== command.client ||
        current.tree.headSha !== command.headSha
      )
        throw new Error(t("gitWorkbench.stale"));
      const unchangedRef = current.refs?.localBranches.some(
        ({ name, sha }) => name === command.ref.name && sha === command.ref.sha,
      );
      if (!unchangedRef || command.ref.name === current.tree.currentBranch)
        throw new Error(t("gitWorkbench.stale"));
      const response = await current.client
        .checkoutGitBranchMutate({
          ...target,
          expectedHeadSha: command.headSha,
          action: "delete",
          name: `refs/heads/${command.ref.name}`,
          expectedRefSha: command.ref.sha,
          force: true,
        })
        .finally(refresh);
      if (!response.success) throw new Error(response.error ?? t("gitWorkbench.failed"));
      setForce(undefined);
      return true;
    });
  });
  const create = useStableEvent(
    () => void mutateTag({ action: "create", tagName: tagName.trim() }),
  );
  const openPush = useStableEvent((tag: Ref) =>
    setTagToPush({ tag, headSha: tree.headSha, client }),
  );
  const openForce = useStableEvent((action: Omit<ForceAction, "client">) =>
    setForce({ ...action, client }),
  );
  const closePush = useStableEvent(() => setTagToPush(undefined));
  const closeForce = useStableEvent(() => setForce(undefined));
  const push = useStableEvent((remote: string) => {
    if (tagToPush) void mutateTag({ action: "push", ...tagToPush, remote });
  });
  const forceWrite = useStableEvent((value: string) => {
    if (force) void mutateForced(force, value);
  });
  const error = refs.error?.message;
  const canCreate = ready && !busy && Boolean(tree.headSha && tagName.trim());
  const noticeError = notice?.error ? notice.text : undefined;
  const buttonDisabled = !ready || busy;
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.panel}>
      <RefsStatus loading={loadingRefs} error={error} notice={notice} />
      <View style={styles.section}>
        <EditingTextInput
          accessibilityLabel={copy.tagName}
          placeholder={copy.tagName}
          ref={tagInput}
          onChangeText={setTagName}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!busy}
        />
        <Button size="sm" variant="outline" disabled={!canCreate} onPress={create}>
          {copy.createTag}
        </Button>
      </View>
      {refs.data ? (
        <TagList
          refs={refs.data}
          disabled={buttonDisabled}
          openPush={openPush}
          mutateTag={mutateTag}
        />
      ) : null}
      <BranchActions refs={refs.data} disabled={buttonDisabled} tree={tree} onForce={openForce} />
      {tagToPush ? (
        <PushTagDialog
          key={tagToPush.tag.name}
          tag={tagToPush.tag}
          remotes={remoteNames}
          visible={active}
          busy={busy}
          ready={ready && client === tagToPush.client}
          onClose={closePush}
          onPush={push}
          error={noticeError}
        />
      ) : null}
      {force ? (
        <ForceDialog
          key={forcePhrase(force)}
          title={copy.forceDelete}
          phrase={forcePhrase(force)}
          target={`refs/heads/${force.ref.name}`}
          sha={force.ref.sha}
          visible={active}
          busy={busy}
          ready={ready && client === force.client}
          onClose={closeForce}
          onConfirm={forceWrite}
          error={noticeError}
        />
      ) : null}
    </ScrollView>
  );
}

function matchesTagSelection(command: TagAction, refs?: Refs) {
  if (command.action === "create") return true;
  if (!command.tag.objectSha || !refs) return false;
  const sameTag = refs.tags.some(
    ({ name, objectSha }) => name === command.tag.name && objectSha === command.tag.objectSha,
  );
  return (
    sameTag &&
    (command.action === "delete" || refs.remotes.some(({ name }) => name === command.remote))
  );
}

function useRepoRefs({
  serverId,
  cwd,
  tree,
  client,
  active,
  connected,
  canWrite,
}: {
  serverId: string;
  cwd: string;
  tree: CheckoutGitWorkingTree;
  client: Client | null;
  active: boolean;
  connected: boolean;
  canWrite: boolean;
}) {
  const { t } = useTranslation();
  const readEnabled = Boolean(client && active && connected);
  const refs = useFetchQuery({
    queryKey: ["git-p2-refs", serverId, cwd, tree.repoRoot],
    dataShape: "value",
    enabled: readEnabled,
    staleTimeMs: 0,
    retry: false,
    queryFn: async () => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      const result = await client.checkoutGitRefsList({ cwd, repoRoots: [tree.repoRoot] });
      if (result.error) throw new Error(result.error);
      const repoRefs = result.refs.find((item) => item.repoRoot === tree.repoRoot);
      if (!repoRefs) throw new Error(t("gitWorkbench.noRepository"));
      return repoRefs;
    },
  });
  const ready = Boolean(
    client && active && connected && canWrite && refs.data && !refs.isError && !refs.isFetching,
  );
  return { refs, ready, loadingRefs: refs.isPending && readEnabled };
}

function RefsStatus({
  loading,
  error,
  notice,
}: {
  loading: boolean;
  error?: string;
  notice?: { text: string; error: boolean };
}) {
  const { t } = useTranslation();
  return (
    <>
      {loading ? <Text style={styles.text}>{t("common.loading")}</Text> : null}
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      {notice ? (
        <Text
          style={notice.error ? styles.error : styles.text}
          accessibilityRole={notice.error ? "alert" : undefined}
        >
          {notice.text}
        </Text>
      ) : null}
    </>
  );
}

function TagList({
  refs,
  disabled,
  openPush,
  mutateTag,
}: {
  refs: Refs;
  disabled: boolean;
  openPush: (tag: Ref) => void;
  mutateTag: (command: TagAction) => Promise<void>;
}) {
  const copy = useGitP2Copy();
  const haveRemotes = refs.remotes.length > 0;
  return (
    <>
      {refs.tags.length === 0 ? <Text style={styles.text}>{copy.noTags}</Text> : null}
      {haveRemotes ? null : <Text style={styles.text}>{copy.noRemotes}</Text>}
      {refs.tags.map((tag) => (
        <TagRow
          key={tag.name}
          tag={tag}
          disabled={disabled}
          haveRemotes={haveRemotes}
          openPush={openPush}
          mutateTag={mutateTag}
        />
      ))}
    </>
  );
}

function TagRow({
  tag,
  disabled,
  haveRemotes,
  openPush,
  mutateTag,
}: {
  tag: Ref;
  disabled: boolean;
  haveRemotes: boolean;
  openPush: (tag: Ref) => void;
  mutateTag: (command: TagAction) => Promise<void>;
}) {
  const copy = useGitP2Copy();
  const push = useStableEvent(() => openPush(tag));
  const remove = useStableEvent(() => void mutateTag({ action: "delete", tag }));
  return (
    <View style={styles.section}>
      <Text style={styles.text} selectable>
        {tag.name} · {tag.sha.slice(0, 8)}
      </Text>
      <View style={styles.actions}>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || !haveRemotes || !tag.objectSha}
          onPress={push}
        >
          {copy.pushTag}
        </Button>
        <Button size="sm" variant="ghost" disabled={disabled || !tag.objectSha} onPress={remove}>
          {copy.deleteTag}
        </Button>
      </View>
    </View>
  );
}

function BranchActions({
  refs,
  disabled,
  tree,
  onForce,
}: {
  refs?: Refs;
  disabled: boolean;
  tree: CheckoutGitWorkingTree;
  onForce: (action: Omit<ForceAction, "client">) => void;
}) {
  const { t } = useTranslation();
  const copy = useGitP2Copy();
  const [branch, setBranch] = useState<string | null>(null);
  const branches = useMemo(
    () => (refs?.localBranches ?? []).filter(({ name }) => name !== tree.currentBranch),
    [refs, tree.currentBranch],
  );
  const options = useMemo(
    () => branches.map(({ name }) => ({ id: name, value: name, label: name })),
    [branches],
  );
  const deletion = branches.find(({ name }) => name === branch);
  const selected = useMemo(() => (deletion ? { label: deletion.name } : null), [deletion]);
  const requestDelete = useStableEvent(() => {
    if (!disabled && deletion && tree.headSha) onForce({ ref: deletion, headSha: tree.headSha });
  });
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.text}>
        {t("gitWorkbench.graph.branches")}
      </Text>
      <SelectField
        triggerTestID="git-force-delete-branch"
        label={t("gitWorkbench.graph.branch")}
        options={options}
        value={deletion?.name ?? null}
        selectedDisplay={selected}
        onChange={setBranch}
        placeholder={t("gitWorkbench.graph.branch")}
        emptyText={copy.noBranches}
        disabled={disabled}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || !deletion || !tree.headSha}
        testID="git-force-delete"
        onPress={requestDelete}
      >
        {copy.forceDelete}
      </Button>
    </View>
  );
}

function PushTagDialog({
  tag,
  remotes,
  visible,
  busy,
  ready,
  onClose,
  onPush,
  error,
}: {
  tag: Ref;
  remotes: string[];
  visible: boolean;
  busy: boolean;
  ready: boolean;
  onClose: () => void;
  onPush: (remote: string) => void;
  error?: string;
}) {
  const { t } = useTranslation();
  const copy = useGitP2Copy();
  const [remote, setRemote] = useState<string | null>(null);
  const selected = remote && remotes.includes(remote) ? remote : null;
  const submit = useStableEvent(() => {
    if (selected) onPush(selected);
  });
  return (
    <Modal visible={visible} transparent onRequestClose={busy ? undefined : onClose}>
      <View style={styles.backdrop}>
        <View style={styles.dialog} testID="git-push-tag-dialog">
          <Text style={styles.text} accessibilityRole="header">
            {copy.pushTag} · {tag.name}
          </Text>
          <Text style={styles.text} selectable>
            {tag.objectSha}
          </Text>
          {error ? (
            <Text style={styles.error} accessibilityRole="alert">
              {error}
            </Text>
          ) : null}
          <Text style={styles.text}>{copy.remote}</Text>
          <ScrollView style={styles.remoteList} contentContainerStyle={styles.actions}>
            {remotes.length === 0 ? <Text style={styles.text}>{copy.noRemotes}</Text> : null}
            {remotes.map((name) => (
              <RemoteChoice
                key={name}
                name={name}
                selected={selected === name}
                onSelect={setRemote}
                disabled={busy}
              />
            ))}
          </ScrollView>
          <View style={styles.actions}>
            <Button size="sm" variant="ghost" onPress={onClose} disabled={busy}>
              {t("common.actions.cancel")}
            </Button>
            <Button
              size="sm"
              testID="git-push-tag-submit"
              onPress={submit}
              disabled={!ready || busy || !selected}
            >
              {busy ? t("common.loading") : copy.pushTag}
            </Button>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const selectedRemote = { selected: true };
const unselectedRemote = { selected: false };

function RemoteChoice({
  name,
  selected,
  disabled,
  onSelect,
}: {
  name: string;
  selected: boolean;
  disabled: boolean;
  onSelect: (name: string) => void;
}) {
  const select = useStableEvent(() => onSelect(name));
  return (
    <Button
      size="sm"
      variant={selected ? "default" : "outline"}
      accessibilityState={selected ? selectedRemote : unselectedRemote}
      onPress={select}
      disabled={disabled}
    >
      {name}
    </Button>
  );
}

function forcePhrase(action: ForceAction) {
  return `force-delete ${action.ref.name}`;
}

export function ForceDialog({
  title,
  phrase,
  target,
  sha,
  visible,
  busy,
  ready,
  onClose,
  onConfirm,
  error,
}: {
  title: string;
  phrase: string;
  target: string;
  sha: string;
  visible: boolean;
  busy: boolean;
  ready: boolean;
  onClose: () => void;
  onConfirm: (value: string) => void;
  error?: string;
}) {
  const { t } = useTranslation();
  const copy = useGitP2Copy();
  const [typed, setTyped] = useState("");
  const expected = phrase;
  const submit = useStableEvent(() => {
    if (typed === expected) onConfirm(typed);
  });
  return (
    <Modal visible={visible} transparent onRequestClose={busy ? undefined : onClose}>
      <View style={styles.backdrop}>
        <View style={styles.dialog} testID="git-force-confirm-dialog">
          <Text style={styles.text} accessibilityRole="header">
            {title}
          </Text>
          <Text style={styles.text} selectable testID="git-force-target">
            {target}
          </Text>
          <Text style={styles.text} selectable testID="git-force-sha">
            {sha}
          </Text>
          <Text style={styles.text} selectable>
            {copy.typeConfirmation}: {expected}
          </Text>
          {error ? (
            <Text style={styles.error} accessibilityRole="alert">
              {error}
            </Text>
          ) : null}
          <EditingTextInput
            testID="git-force-confirm-input"
            accessibilityLabel={copy.typeConfirmation}
            onChangeText={setTyped}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
          />
          <View style={styles.actions}>
            <Button size="sm" variant="ghost" onPress={onClose} disabled={busy}>
              {t("common.actions.cancel")}
            </Button>
            <Button
              size="sm"
              disabled={!ready || busy || typed !== expected}
              testID="git-force-confirm-submit"
              onPress={submit}
            >
              {busy ? t("common.loading") : t("gitWorkbench.confirm")}
            </Button>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  scroll: { flex: 1 },
  panel: { padding: theme.spacing[2], gap: theme.spacing[3] },
  section: { gap: theme.spacing[2] },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  remoteList: { maxHeight: 160, flexGrow: 0 },
  text: { color: theme.colors.foreground },
  error: { color: theme.colors.destructive },
  backdrop: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.45)",
    padding: theme.spacing[3],
  },
  dialog: {
    width: "100%",
    maxWidth: 440,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    gap: theme.spacing[2],
    padding: theme.spacing[3],
  },
}));
