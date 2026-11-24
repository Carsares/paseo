import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import { topicUpgradeEnglish } from "./copy";
import {
  canConfirmTopicUpgrade,
  confirmTopicUpgrade,
  loadTopicUpgradePlan,
  type TopicUpgradeClient,
  type TopicUpgradePlan,
  type WorkspaceTopic,
} from "./model";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner, mutedIconColorMapping);

interface WorkspaceTopicUpgradeDialogProps {
  client: TopicUpgradeClient | null;
  workspaceId: string;
  onClose: () => void;
  onUpgraded: (topic: WorkspaceTopic) => void;
}

type UpgradeCopy = (key: keyof typeof topicUpgradeEnglish) => string;
type UpgradeCandidate = Extract<TopicUpgradePlan, { kind: "choose" }>["candidates"][number];

type LoadState =
  | { kind: "loading" }
  | { kind: "failed"; error: string }
  | { kind: "ready"; plan: TopicUpgradePlan };

export function WorkspaceTopicUpgradeDialog({
  client,
  workspaceId,
  onClose,
  onUpgraded,
}: WorkspaceTopicUpgradeDialogProps) {
  const { t, i18n } = useTranslation();
  const copy = useCallback<UpgradeCopy>(
    (key) => t("topicWorkbench.upgrade." + key, { defaultValue: topicUpgradeEnglish[key] }),
    [t],
  );
  const title = copy("title");
  const header = useMemo(() => ({ title }), [title]);
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{ kind: "changed" } | { kind: "error"; message: string }>();
  const [sheetRevision, setSheetRevision] = useState(0);
  const pending = useRef(false);
  const scope = useRef<object | null>(null);

  useEffect(() => {
    const current = {};
    scope.current = current;
    setLoad({ kind: "loading" });
    setSelectedId(null);
    setNotice(undefined);
    setSubmitting(false);
    pending.current = false;
    async function loadPlan() {
      try {
        const plan = await loadTopicUpgradePlan(client, workspaceId);
        if (scope.current === current) setLoad({ kind: "ready", plan });
      } catch (error: unknown) {
        if (scope.current === current) setLoad({ kind: "failed", error: errorMessage(error) });
      }
    }
    void loadPlan();
    return () => {
      scope.current = null;
    };
  }, [client, workspaceId, attempt]);

  const plan = load.kind === "ready" ? load.plan : null;
  const canConfirm = client !== null && canConfirmTopicUpgrade(plan, selectedId);
  const close = useCallback(() => {
    if (!pending.current) onClose();
  }, [onClose]);
  const handleDismiss = useCallback(() => {
    if (pending.current) setSheetRevision((revision) => revision + 1);
  }, []);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  const submit = useCallback(async () => {
    const current = scope.current;
    if (!current || !client || !canConfirm || pending.current) return;
    pending.current = true;
    setSubmitting(true);
    setNotice(undefined);
    try {
      const result = await confirmTopicUpgrade({ client, workspaceId, selectedId });
      if (scope.current !== current) return;
      if (result.kind === "upgraded") {
        onUpgraded(result.topic);
        return;
      }
      setLoad({ kind: "ready", plan: result.plan });
      setSelectedId(null);
      if (result.plan.kind === "choose") setNotice({ kind: "changed" });
    } catch (error: unknown) {
      if (scope.current === current) setNotice({ kind: "error", message: errorMessage(error) });
    } finally {
      if (scope.current === current) {
        pending.current = false;
        setSubmitting(false);
      }
    }
  }, [canConfirm, client, onUpgraded, selectedId, workspaceId]);

  const showRetry = load.kind === "failed" || plan?.kind === "disconnected";
  const showConfirm = plan?.kind === "choose";
  const footer = useMemo(
    () => (
      <View style={styles.actions}>
        <Button variant="secondary" disabled={submitting} onPress={close}>
          {t("common.actions.cancel")}
        </Button>
        {showRetry && <Button onPress={retry}>{t("common.actions.retry")}</Button>}
        {showConfirm && (
          <Button
            disabled={!canConfirm}
            loading={submitting}
            onPress={submit}
            testID="confirm-topic-upgrade"
          >
            {copy("confirm")}
          </Button>
        )}
      </View>
    ),
    [canConfirm, close, copy, retry, showConfirm, showRetry, submit, submitting, t],
  );

  return (
    <AdaptiveModalSheet
      key={sheetRevision}
      visible
      header={header}
      showCloseButton={!submitting}
      onClose={close}
      onDismiss={handleDismiss}
      testID="workspace-topic-upgrade"
      footer={footer}
    >
      <View style={styles.body}>
        <UpgradeBody
          load={load}
          copy={copy}
          locale={i18n.language}
          selectedId={selectedId}
          submitting={submitting}
          onSelect={setSelectedId}
        />
        {notice?.kind === "error" && (
          <Alert variant="error" title={copy("submitError")} description={notice.message} />
        )}
        {notice?.kind === "changed" && <Alert variant="info" description={copy("changed")} />}
      </View>
    </AdaptiveModalSheet>
  );
}

function UpgradeBody({
  load,
  copy,
  locale,
  selectedId,
  submitting,
  onSelect,
}: {
  load: LoadState;
  copy: UpgradeCopy;
  locale: string;
  selectedId: string | null;
  submitting: boolean;
  onSelect: (id: string) => void;
}) {
  if (load.kind === "loading") {
    return (
      <View style={styles.loading}>
        <ThemedLoadingSpinner size={14} />
        <Text style={styles.description}>{copy("loading")}</Text>
      </View>
    );
  }
  if (load.kind === "failed") {
    return <Alert variant="error" title={copy("loadError")} description={load.error} />;
  }
  const plan = load.plan;
  if (plan.kind !== "choose") return <Alert variant="info" description={copy(plan.kind)} />;

  const { candidates, existingMainId } = plan;
  return (
    <>
      <Text style={styles.description}>{copy("preserve")}</Text>
      {candidates.length === 0 ? (
        <Text style={styles.description}>{copy("empty")}</Text>
      ) : (
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel={copy("choose")}
          style={styles.options}
        >
          <Text accessibilityRole="header" style={styles.chooserLabel}>
            {copy("choose")}
          </Text>
          {existingMainId && <Text style={styles.description}>{copy("existing")}</Text>}
          {candidates.map((candidate) => (
            <CandidateRow
              key={candidate.id}
              candidate={candidate}
              unnamedLabel={copy("unnamed")}
              locale={locale}
              checked={candidate.id === selectedId}
              disabled={submitting || (existingMainId !== null && candidate.id !== existingMainId)}
              onSelect={onSelect}
            />
          ))}
        </View>
      )}
    </>
  );
}

function CandidateRow({
  candidate,
  unnamedLabel,
  locale,
  checked,
  disabled,
  onSelect,
}: {
  candidate: UpgradeCandidate;
  unnamedLabel: string;
  locale: string;
  checked: boolean;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  const handlePress = useCallback(() => onSelect(candidate.id), [candidate.id, onSelect]);
  const accessibilityState = useMemo(() => ({ checked, disabled }), [checked, disabled]);
  return (
    <PressHighlight
      accessibilityRole="radio"
      accessibilityState={accessibilityState}
      aria-checked={checked}
      disabled={disabled}
      onPress={handlePress}
      style={[styles.option, checked && styles.selectedOption, disabled && styles.disabledOption]}
    >
      <View style={[styles.radio, checked && styles.selectedRadio]}>
        {checked && <View style={styles.radioDot} />}
      </View>
      <View style={styles.optionText}>
        <Text style={styles.optionTitle}>{candidate.title?.trim() || unnamedLabel}</Text>
        <Text style={styles.description}>
          {candidate.provider} · {new Date(candidate.createdAt).toLocaleString(locale)} ·{" "}
          {candidate.id.slice(0, 8)}
        </Text>
      </View>
    </PressHighlight>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[4], paddingVertical: theme.spacing[4] },
  loading: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  description: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  chooserLabel: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  options: { gap: theme.spacing[2] },
  option: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[3],
  },
  optionText: { flex: 1, gap: theme.spacing[1] },
  optionTitle: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  selectedOption: { backgroundColor: theme.colors.surface2 },
  disabledOption: { opacity: 0.6 },
  radio: {
    height: 16,
    width: 16,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    borderColor: theme.colors.border,
  },
  selectedRadio: { borderColor: theme.colors.foreground },
  radioDot: { height: 8, width: 8, borderRadius: 4, backgroundColor: theme.colors.foreground },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
