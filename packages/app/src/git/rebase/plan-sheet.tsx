import { useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { CheckoutGitRepo } from "@getpaseo/protocol/messages";
import { GraphSheet } from "../graph/sheet";
import {
  DraggableList,
  DraggableListHandle,
  type DraggableRenderItemInfo,
} from "@/components/draggable-list";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { useStableEvent } from "@/hooks/use-stable-event";
import { confirmDialog } from "@/utils/confirm-dialog";
import { GraphInput, GraphMessage, errorMessage, styles } from "../graph/ui";
import { useLiveEnabled } from "./use-live-enabled";
import {
  compilePlan,
  createPlanRows,
  REBASE_ACTIONS,
  type PlanAction,
  type PlanIssue,
  type PlanRow,
} from "./plan-model";

type Plan = Awaited<ReturnType<DaemonClient["checkoutGitRebaseBuildPlan"]>>;
export type RebaseResult = Awaited<ReturnType<DaemonClient["checkoutGitRebaseExecute"]>>;

export function PlanSheet({
  client,
  cwd,
  repo,
  enabled,
  onClose,
  onResult,
  ontoOptions,
}: {
  client: DaemonClient;
  cwd: string;
  repo: CheckoutGitRepo;
  enabled: boolean;
  onClose: () => void;
  onResult: (result: RebaseResult, plannedSteps: number) => void;
  ontoOptions: string[];
}) {
  const { t } = useTranslation();
  const [onto, setOnto] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const pending = useRef(false);
  const liveEnabled = useLiveEnabled(enabled);
  const compiled = compilePlan(rows);
  const target = { cwd, targetRepoRoot: repo.repoRoot };

  async function run(operation: () => Promise<void>) {
    if (pending.current || !liveEnabled.current) return;
    pending.current = true;
    setBusy(true);
    setNotice(undefined);
    try {
      await operation();
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  function build(dryRun: boolean) {
    return run(async () => {
      const result = await client.checkoutGitRebaseBuildPlan({
        ...target,
        ontoRef: onto.trim(),
        dryRun,
      });
      if (result.error) throw new Error(result.error);
      if (dryRun && plan) {
        if (plan.headSha !== result.headSha || plan.ontoSha !== result.ontoSha) {
          setPlan(null);
          setRows([]);
          throw new Error(t("gitWorkbench.graph.staleHead"));
        }
        setPlan({ ...plan, conflictPaths: result.conflictPaths });
      } else {
        setPlan(result);
        setRows(createPlanRows(result.entries));
      }
    });
  }

  function execute() {
    if (!compiled.steps || !plan?.headSha || !plan.ontoSha) return;
    const { steps } = compiled;
    const { headSha, ontoSha } = plan;
    return run(async () => {
      const approved = await confirmDialog({
        title: t("gitWorkbench.graph.executeTitle"),
        message: [
          t("gitWorkbench.graph.executeBody", {
            branch: repo.currentBranch ?? headSha.slice(0, 8),
            repo: repo.displayName,
          }),
          plan.isPushedRange ? t("gitWorkbench.graph.pushedRange") : null,
        ]
          .filter(Boolean)
          .join("\n\n"),
        confirmLabel: t("gitWorkbench.graph.execute"),
        destructive: true,
      });
      if (!approved || !liveEnabled.current) return;
      const checkout = await client.checkoutGitReposDiscover({
        cwd,
        maxDepth: 2,
        includeWorktrees: true,
      });
      if (checkout.error) throw new Error(checkout.error);
      const current = checkout.repos.find((item) => item.repoRoot === repo.repoRoot);
      if (!current || current.currentBranch !== repo.currentBranch || current.headSha !== headSha) {
        setPlan(null);
        setRows([]);
        throw new Error(t("gitWorkbench.graph.staleHead"));
      }
      if (!liveEnabled.current) return;
      const result = await client.checkoutGitRebaseExecute({
        ...target,
        // The plan was built against these two commits. A moving ref cannot change the base.
        ontoRef: ontoSha,
        expectedHeadSha: headSha,
        steps,
      });
      if (result.errorCode === "STALE_HEAD_CONFLICT") {
        setPlan(null);
        setRows([]);
        throw new Error(t("gitWorkbench.graph.staleHead"));
      }
      if (result.errorCode === "ACTIVE_AGENT_GUARD") {
        throw new Error(
          [
            t("gitWorkbench.graph.activeAgents"),
            ...(result.activeAgents ?? []).map((agent) => agent.title || agent.agentId),
          ].join("\n"),
        );
      }
      if (
        result.success ||
        result.operationState === "rebase_paused" ||
        result.operationState === "rebase"
      ) {
        onResult(result, steps.length);
        return;
      }
      throw new Error(result.error ?? t("gitWorkbench.graph.rebaseFailed"));
    });
  }

  function updateRow(sha: string, update: Partial<Pick<PlanRow, "type" | "message">>) {
    setRows((current) => current.map((row) => (row.sha === sha ? { ...row, ...update } : row)));
  }

  function move(index: number, offset: number) {
    setRows((current) => {
      const next = [...current];
      const [row] = next.splice(index, 1);
      next.splice(index + offset, 0, row);
      return next;
    });
  }

  const disabled = busy || !enabled;
  const close = useStableEvent(() => {
    if (!pending.current) onClose();
  });
  const preflight = useStableEvent(() => void build(true));
  const buildPlan = useStableEvent(() => void build(false));
  const runPlan = useStableEvent(() => void execute());
  const changeOnto = useStableEvent((value: string) => {
    setOnto(value);
    setPlan(null);
    setRows([]);
  });
  const onDragEnd = useStableEvent((order: PlanRow[]) => {
    if (!pending.current) setRows(order);
  });
  const update = useStableEvent(updateRow);
  const moveRow = useStableEvent(move);
  const extraData = useMemo(() => ({ disabled, length: rows.length }), [disabled, rows.length]);
  const renderItem = useStableEvent(({ item, index }: DraggableRenderItemInfo<PlanRow>) => (
    <PlanEntry
      item={item}
      index={index}
      disabled={disabled}
      last={index === rows.length - 1}
      onMove={moveRow}
      onChange={update}
    />
  ));
  const title = t("gitWorkbench.graph.plan");
  const header = useMemo(() => ({ title }), [title]);
  const canExecute = !disabled && !!compiled.steps && !!plan?.headSha && !!plan.ontoSha;
  const footer = useMemo(
    () => (
      <View style={styles.wrap}>
        <Button variant="outline" disabled={disabled || !plan} onPress={preflight}>
          {t("gitWorkbench.graph.preflight")}
        </Button>
        <Button disabled={!canExecute} onPress={runPlan}>
          {t("gitWorkbench.graph.execute")}
        </Button>
      </View>
    ),
    [disabled, plan, preflight, t, canExecute, runPlan],
  );

  return (
    <GraphSheet
      visible
      header={header}
      onClose={close}
      desktopMaxWidth={720}
      desktopHeight="80%"
      snapPoints={PLAN_SNAP_POINTS}
      scrollable={false}
      testID="git-rebase-plan"
      footer={footer}
    >
      <PlanControls
        repo={repo}
        disabled={disabled}
        onto={onto}
        ontoOptions={ontoOptions}
        onChange={changeOnto}
        onBuild={buildPlan}
        plan={plan}
        issue={compiled.issue}
        notice={notice}
      />
      <DraggableList
        style={styles.fill}
        data={rows}
        keyExtractor={planKey}
        useDragHandle
        gestureHostPresented={!disabled}
        onDragEnd={onDragEnd}
        renderItem={renderItem}
        extraData={extraData}
      />
    </GraphSheet>
  );
}

const PLAN_SNAP_POINTS = ["90%"];
const planKey = (row: PlanRow) => row.sha;

function PlanControls({
  repo,
  disabled,
  onto,
  ontoOptions,
  onChange,
  onBuild,
  plan,
  issue,
  notice,
}: {
  repo: CheckoutGitRepo;
  disabled: boolean;
  onto: string;
  ontoOptions: string[];
  onChange: (value: string) => void;
  onBuild: () => void;
  plan: Plan | null;
  issue?: PlanIssue;
  notice?: string;
}) {
  const { t } = useTranslation();
  const ontoLabel = t("gitWorkbench.graph.onto");
  const refLabel = t("gitWorkbench.graph.refs");
  const paths = plan?.conflictPaths;
  return (
    <View style={styles.stack}>
      <Text style={styles.heading}>
        {repo.displayName} · {repo.currentBranch ?? repo.headSha?.slice(0, 8)}
      </Text>
      <View style={styles.wrap}>
        <GraphInput
          accessibilityLabel={ontoLabel}
          placeholder={ontoLabel}
          autoCapitalize="none"
          editable={!disabled}
          style={styles.fill}
          value={onto}
          onChangeText={onChange}
        />
        <Button variant="outline" disabled={disabled || !onto.trim()} onPress={onBuild}>
          {t("gitWorkbench.graph.buildPlan")}
        </Button>
      </View>
      {!plan && ontoOptions.length > 0 ? (
        <SelectField
          field={false}
          label={refLabel}
          placeholder={refLabel}
          emptyText={refLabel}
          value={onto}
          selectedDisplay={null}
          options={ontoOptions.map((value) => ({ id: value, value, label: value }))}
          onChange={onChange}
          disabled={disabled}
        />
      ) : null}
      {plan?.isPushedRange ? (
        <GraphMessage error>{t("gitWorkbench.graph.pushedRange")}</GraphMessage>
      ) : null}
      {paths ? (
        <>
          <GraphMessage>{t("gitWorkbench.graph.rebaseRefPreflight")}</GraphMessage>
          <GraphMessage error={paths.length > 0}>
            {paths.length
              ? [t("gitWorkbench.graph.preflightConflicts"), ...paths].join("\n")
              : t("gitWorkbench.graph.preflightClear")}
          </GraphMessage>
        </>
      ) : null}
      {plan && issue ? <GraphMessage error>{t(`gitWorkbench.graph.${issue}`)}</GraphMessage> : null}
      {notice ? <GraphMessage error>{notice}</GraphMessage> : null}
    </View>
  );
}

function PlanEntry({
  item,
  index,
  disabled,
  last,
  onMove,
  onChange,
}: {
  item: PlanRow;
  index: number;
  disabled: boolean;
  last: boolean;
  onMove: (index: number, offset: number) => void;
  onChange: (sha: string, update: Partial<Pick<PlanRow, "type" | "message">>) => void;
}) {
  const { t } = useTranslation();
  const changeAction = useStableEvent((type: PlanAction) => onChange(item.sha, { type }));
  const changeMessage = useStableEvent((message: string) => onChange(item.sha, { message }));
  const up = useStableEvent(() => onMove(index, -1));
  const down = useStableEvent(() => onMove(index, 1));
  const label = t(`gitWorkbench.graph.${item.type}`);
  const display = useMemo(() => ({ label }), [label]);
  return (
    <View style={[styles.stack, styles.rowBorder]}>
      <View style={styles.row}>
        {!disabled ? (
          <DraggableListHandle
            accessibilityLabel={t("gitWorkbench.graph.reorder", { subject: item.subject })}
          >
            <Text style={styles.heading}>⠿</Text>
          </DraggableListHandle>
        ) : null}
        <Text style={[styles.heading, styles.fill]} numberOfLines={2}>
          {item.subject}
        </Text>
        <Text style={styles.muted}>{item.sha.slice(0, 8)}</Text>
      </View>
      <View style={styles.wrap}>
        <SelectField
          field={false}
          label={t("gitWorkbench.graph.plan")}
          placeholder={t("gitWorkbench.graph.pick")}
          emptyText={t("gitWorkbench.graph.pick")}
          value={item.type}
          selectedDisplay={display}
          options={REBASE_ACTIONS.map((type) => ({
            id: type,
            value: type,
            label: t(`gitWorkbench.graph.${type}`),
          }))}
          onChange={changeAction}
          disabled={disabled}
        />
        <Button size="sm" variant="ghost" disabled={disabled || index === 0} onPress={up}>
          {t("gitWorkbench.graph.moveEarlier")}
        </Button>
        <Button size="sm" variant="ghost" disabled={disabled || last} onPress={down}>
          {t("gitWorkbench.graph.moveLater")}
        </Button>
      </View>
      {item.type === "reword" ? (
        <GraphInput
          accessibilityLabel={t("gitWorkbench.graph.newMessage")}
          placeholder={t("gitWorkbench.graph.newMessage")}
          value={item.message}
          onChangeText={changeMessage}
          editable={!disabled}
          multiline
        />
      ) : null}
    </View>
  );
}
