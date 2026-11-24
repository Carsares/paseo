import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenuHint,
  DropdownMenuItem,
  DropdownMenuSubTrigger,
  type MenuPageDefinition,
} from "@/components/ui/dropdown-menu";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import {
  formatDeferralTime,
  workspaceDeferralKind,
  type WorkspaceDeferralKind,
} from "@/workspace-deferral/model";
import {
  useDeferralOperation,
  useWorkspaceDeferralSupport,
  type WorkspaceDeferralTarget,
} from "@/workspace-deferral/operations";
import type { DeferredWorkspaceRow } from "@/workspace-deferral/directory";

const DEFERRAL_PAGE = "workspace-deferral";
const durations = [
  { key: "oneHour", hours: 1 },
  { key: "fourHours", hours: 4 },
  { key: "oneDay", hours: 24 },
] as const;

const projectDeferralWorkspace = (workspace: WorkspaceDescriptor) => ({
  kind: workspaceDeferralKind(workspace),
  snoozedUntil: workspace.snoozedUntil,
  archivingAt: workspace.archivingAt,
});

export function useSidebarWorkspaceDeferralMenu(
  serverId: string | undefined,
  workspaceId: string | undefined,
): { pages: MenuPageDefinition[]; trigger: React.ReactNode } {
  const { t } = useTranslation();
  const supported = useWorkspaceDeferralSupport(serverId ?? "");
  if (!supported || !serverId || !workspaceId) {
    return { pages: [], trigger: null };
  }
  const title = t("sidebar.workspace.deferral.menu");
  return {
    pages: [
      {
        id: DEFERRAL_PAGE,
        title,
        content: (
          <WorkspaceDeferralPage
            key={JSON.stringify([serverId, workspaceId])}
            serverId={serverId}
            workspaceId={workspaceId}
          />
        ),
      },
    ],
    trigger: (
      <DropdownMenuSubTrigger id={DEFERRAL_PAGE} testID="workspace-deferral-trigger">
        {title}
      </DropdownMenuSubTrigger>
    ),
  };
}

export function WorkspaceDeferralPage({ serverId, workspaceId }: WorkspaceDeferralTarget) {
  const { t, i18n } = useTranslation();
  const workspace = useWorkspaceFields(serverId, workspaceId, projectDeferralWorkspace);
  const { supported, online, pending, error, run } = useDeferralOperation(serverId);
  const restore = useCallback(
    () => void run((client) => client.setWorkspaceDeferral({ workspaceId, action: "restore" })),
    [run, workspaceId],
  );
  const park = useCallback(
    () => void run((client) => client.setWorkspaceDeferral({ workspaceId, action: "park" })),
    [run, workspaceId],
  );
  const snoozeOptions = useMemo(
    () =>
      durations.map(({ key, hours }) => ({
        key,
        onSelect: () =>
          void run((client) =>
            client.setWorkspaceDeferral({
              workspaceId,
              action: "snooze",
              snoozedUntil: new Date(Date.now() + hours * 60 * 60 * 1000).toISOString(),
            }),
          ),
      })),
    [run, workspaceId],
  );
  if (!workspace || workspace.archivingAt) return null;
  const disabled = !supported || !online || pending;
  return (
    <>
      {workspace.kind ? (
        <>
          <DropdownMenuHint>
            {workspace.snoozedUntil
              ? t("sidebar.workspace.deferral.snoozedUntil", {
                  time: formatDeferralTime(workspace.snoozedUntil, i18n.language),
                })
              : t("sidebar.workspace.deferral.parked")}
          </DropdownMenuHint>
          <DropdownMenuItem
            onSelect={restore}
            disabled={disabled}
            closeOnSelect={false}
            testID="workspace-deferral-restore"
          >
            {t("sidebar.workspace.deferral.restore")}
          </DropdownMenuItem>
        </>
      ) : (
        <>
          {snoozeOptions.map(({ key, onSelect }) => (
            <DropdownMenuItem
              key={key}
              disabled={disabled}
              closeOnSelect={false}
              testID={`workspace-deferral-${key}`}
              onSelect={onSelect}
            >
              {t(`sidebar.workspace.deferral.${key}`)}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem
            disabled={disabled}
            closeOnSelect={false}
            onSelect={park}
            testID="workspace-deferral-park"
          >
            {t("sidebar.workspace.deferral.park")}
          </DropdownMenuItem>
        </>
      )}
      <DeferralMenuFeedback online={online} pending={pending} error={error} />
    </>
  );
}

function DeferralMenuFeedback({
  online,
  pending,
  error,
}: {
  online: boolean;
  pending: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  if (online && !pending && !error) return null;
  const feedback =
    error ??
    t(online ? "sidebar.workspace.deferral.pending" : "sidebar.workspace.deferral.offline");
  return feedback ? (
    <DropdownMenuHint testID="workspace-deferral-feedback">{feedback}</DropdownMenuHint>
  ) : null;
}

export const DEFERRED_WORKSPACE_PAGES = ["snoozed", "parked"] as const;
export function deferredWorkspacePageId(kind: WorkspaceDeferralKind) {
  return `deferred-workspaces-${kind}`;
}

export function DeferredWorkspaceMenuPage({ rows }: { rows: DeferredWorkspaceRow[] }) {
  return rows.map((row) => (
    <DeferredWorkspaceMenuRow key={JSON.stringify([row.serverId, row.workspace.id])} row={row} />
  ));
}

function DeferredWorkspaceMenuRow({ row }: { row: DeferredWorkspaceRow }) {
  const { t, i18n } = useTranslation();
  const { supported, online, pending, error, run } = useDeferralOperation(row.serverId);
  const name = row.workspace.title ?? row.workspace.name;
  const until = row.workspace.snoozedUntil;
  const workspaceId = row.workspace.id;
  const restore = useCallback(
    () => void run((client) => client.setWorkspaceDeferral({ workspaceId, action: "restore" })),
    [run, workspaceId],
  );
  return (
    <>
      <DropdownMenuItem
        disabled={!supported || !online || pending}
        closeOnSelect={false}
        testID={`deferred-workspace-restore-${row.serverId}-${row.workspace.id}`}
        onSelect={restore}
      >
        {t("sidebar.workspace.deferral.restoreNamed", { name, host: row.hostLabel })}
      </DropdownMenuItem>
      {until ? (
        <DropdownMenuHint>
          {t("sidebar.workspace.deferral.snoozedUntil", {
            time: formatDeferralTime(until, i18n.language),
          })}
        </DropdownMenuHint>
      ) : null}
      <DeferralMenuFeedback online={online} pending={pending} error={error} />
    </>
  );
}
