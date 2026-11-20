import { Folder } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import { ALL_HOSTS_OPTION_ID } from "@/components/hosts/host-picker";
import { ProjectIconView } from "@/components/project-icon-view";
import { Combobox } from "@/components/ui/combobox";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { createControlGeometry } from "@/components/ui/control-geometry";
import { useFetchQueries } from "@/data/query";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useProjects } from "@/hooks/use-projects";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";
import {
  normalizeProjectDescriptor,
  type ProjectDescriptor,
  useSessionStore,
} from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { resolveProjectPlacement } from "@/utils/project-placement";
import { buildProjects, type ProjectSummary } from "@/utils/projects";

export const ALL_PROJECTS_OPTION_ID = "__all_projects__";

export interface HistoryProjectOption {
  id: string;
  label: string;
  projectKeysByServer: ReadonlyMap<string, readonly string[]>;
}

interface ObservedProject {
  serverId: string;
  projectKey: string;
  projectName: string;
  equivalenceKey: string | null;
}

const ThemedFolder = withUnistyles(Folder);
const mutedIconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function projectPlacementKey(serverId: string, projectKey: string): string {
  return JSON.stringify([serverId, projectKey]);
}

function countObservedEquivalents(projects: Iterable<ObservedProject>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { serverId, equivalenceKey } of projects) {
    if (!equivalenceKey) continue;
    const key = projectPlacementKey(serverId, equivalenceKey);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function useArchivedProjectCatalog() {
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const serverIds = useMemo(() => hosts.map(({ serverId }) => serverId), [hosts]);
  const statuses = useHostRuntimeConnectionStatuses(serverIds);
  // COMPAT(agentHistoryQueryControls): added in v0.16.0, remove gate after 2027-05-19.
  const supportedIds = useSessionStore(
    useShallow((state) =>
      serverIds.filter(
        (id) => state.sessions[id]?.serverInfo?.features?.agentHistoryQueryControls === true,
      ),
    ),
  );

  const catalog = useFetchQueries<{ serverId: string; projects: ProjectDescriptor[] }>(
    hosts.map(({ serverId }) => ({
      queryKey: ["historyProjectCatalog", serverId],
      enabled: supportedIds.includes(serverId) && statuses.get(serverId) === "online",
      dataShape: "list",
      staleTimeMs: 30_000,
      refetchOnMount: true,
      queryFn: async () => {
        const client = runtime.getClient(serverId);
        if (!client) throw new Error("Host is disconnected");
        const { projects } = await client.listProjects({ includeArchived: true });
        return { serverId, projects: projects.map(normalizeProjectDescriptor) };
      },
    })),
  );

  return useMemo(() => {
    const hostsWithCatalog = catalog.flatMap(({ data }) =>
      data
        ? [
            {
              serverId: data.serverId,
              serverName:
                hosts.find((host) => host.serverId === data.serverId)?.label ?? data.serverId,
              isOnline: statuses.get(data.serverId) === "online",
              workspaces: [],
              projects: data.projects,
            },
          ]
        : [],
    );
    return { projects: buildProjects({ hosts: hostsWithCatalog }).projects, hostsWithCatalog };
  }, [catalog, hosts, statuses]);
}

function buildHistoryProjectOptions(input: {
  selectedHost: string;
  archived: readonly ProjectSummary[];
  active: readonly ProjectSummary[];
  observed: ReadonlyMap<string, ObservedProject>;
}): HistoryProjectOption[] {
  const options = new Map<string, { label: string; projectKeysByServer: Map<string, string[]> }>();
  const registeredPlacements = new Set<string>();
  const includesHost = (id: string) =>
    input.selectedHost === ALL_HOSTS_OPTION_ID || input.selectedHost === id;

  function add(id: string, label: string, serverId: string, projectKey: string) {
    let option = options.get(id);
    if (!option) {
      option = { label, projectKeysByServer: new Map() };
      options.set(id, option);
    }
    const keys = option.projectKeysByServer.get(serverId);
    if (keys) {
      keys.push(projectKey);
    } else {
      option.projectKeysByServer.set(serverId, [projectKey]);
    }
  }

  // Prefer the live name when both catalogs return the same project. Use the complete
  // catalog's placement first so an archived duplicate on a host doesn't create a second option.
  const activeById = new Map(input.active.map((project) => [project.viewKey, project]));
  const registered = [...input.archived, ...input.active];
  const registeredIds = new Set(registered.map(({ viewKey }) => viewKey));
  for (const project of registered) {
    const named = activeById.get(project.viewKey) ?? project;
    const label = named.projectCustomName?.trim() || named.projectName;
    for (const { serverId, projectId } of project.hosts) {
      if (!includesHost(serverId) || !projectId.trim()) continue;
      const placement = projectPlacementKey(serverId, projectId);
      if (registeredPlacements.has(placement)) continue;
      registeredPlacements.add(placement);
      add(project.viewKey, label, serverId, projectId);
    }
  }

  const equivalenceCountsByHost = countObservedEquivalents(input.observed.values());
  for (const [placement, project] of input.observed) {
    const { serverId, projectKey, projectName, equivalenceKey } = project;
    if (!includesHost(serverId) || registeredPlacements.has(placement)) continue;
    // Registered projects use buildProjects' view key. Give history-only equivalents
    // the same identity format as the History grouping code.
    const sharedId =
      equivalenceKey && registeredIds.has(equivalenceKey) ? equivalenceKey : `eq:${equivalenceKey}`;
    const canMerge =
      equivalenceKey &&
      equivalenceCountsByHost.get(projectPlacementKey(serverId, equivalenceKey)) === 1 &&
      !options.get(sharedId)?.projectKeysByServer.has(serverId);
    add(canMerge ? sharedId : `${serverId}:${projectKey}`, projectName, serverId, projectKey);
  }

  return [...options]
    .map(([id, { label, projectKeysByServer }]) => ({ id, label, projectKeysByServer }))
    .sort(
      (left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id),
    );
}

export function resolveHistoryProjectSelection(
  selection: HistoryProjectOption,
  options: readonly HistoryProjectOption[],
): HistoryProjectOption | null {
  const exact = options.find(({ id }) => id === selection.id);
  if (exact) {
    let merged: Map<string, readonly string[]> | undefined;
    for (const [serverId, keys] of selection.projectKeysByServer) {
      const exactKeys = exact.projectKeysByServer.get(serverId) ?? [];
      const splitKeys = keys.filter(
        (key) =>
          !exactKeys.includes(key) &&
          options.some((option) => option.projectKeysByServer.get(serverId)?.includes(key)),
      );
      if (splitKeys.length > 0) {
        merged ??= new Map(exact.projectKeysByServer);
        merged.set(serverId, [...exactKeys, ...splitKeys]);
      }
    }
    return merged ? { ...exact, projectKeysByServer: merged } : exact;
  }
  // A catalog can replace a history-only ID with a registered view key.
  const matchingPlacements = options.filter(({ projectKeysByServer }) => {
    for (const [serverId, keys] of selection.projectKeysByServer) {
      if (projectKeysByServer.get(serverId)?.some((key) => keys.includes(key))) return true;
    }
    return false;
  });
  return matchingPlacements.length === 1 ? matchingPlacements[0] : null;
}

export function useHistoryProjectOptions({
  selectedHost,
  agents,
  ancestors,
}: {
  selectedHost: string;
  agents: readonly AggregatedAgent[];
  ancestors: readonly AggregatedAgent[];
}) {
  const { projects: active } = useProjects();
  const { projects: archived, hostsWithCatalog } = useArchivedProjectCatalog();
  const activeProjectsByServer = useSessionStore(
    useShallow((state) =>
      Object.fromEntries(
        Object.entries(state.sessions).map(([serverId, session]) => [serverId, session.projects]),
      ),
    ),
  );
  const catalogEquivalenceCounts = useMemo(() => {
    const completeByServer = new Map(
      hostsWithCatalog.map(({ serverId, projects }) => [serverId, projects]),
    );
    const serverIds = new Set([...Object.keys(activeProjectsByServer), ...completeByServer.keys()]);
    const countsByServer = new Map<string, Map<string, number>>();
    for (const serverId of serverIds) {
      const projects = new Map(activeProjectsByServer[serverId]);
      for (const project of completeByServer.get(serverId) ?? []) {
        projects.set(project.projectId, project);
      }
      const counts = new Map<string, number>();
      for (const { projectKey } of projects.values()) {
        if (projectKey?.trim()) counts.set(projectKey, (counts.get(projectKey) ?? 0) + 1);
      }
      countsByServer.set(serverId, counts);
    }
    return countsByServer;
  }, [activeProjectsByServer, hostsWithCatalog]);
  const [observed, setObserved] = useState<ReadonlyMap<string, ObservedProject>>(() => new Map());

  // Keep just the placement metadata. Filtered pages can no longer rediscover other projects.
  useEffect(() => {
    setObserved((previous) => {
      let next: Map<string, ObservedProject> | undefined;
      for (const agent of [...ancestors, ...agents]) {
        const { projectKey, projectName, projectEquivalenceKey } = resolveProjectPlacement({
          projectPlacement: agent.projectPlacement,
          cwd: agent.cwd,
        });
        if (!projectKey.trim()) continue;
        const placement = projectPlacementKey(agent.serverId, projectKey);
        const equivalenceKey = projectEquivalenceKey?.trim() ? projectEquivalenceKey : null;
        const existing = (next ?? previous).get(placement);
        if (existing?.projectName === projectName && existing.equivalenceKey === equivalenceKey) {
          continue;
        }
        next ??= new Map(previous);
        next.set(placement, { serverId: agent.serverId, projectKey, projectName, equivalenceKey });
      }
      return next ?? previous;
    });
  }, [agents, ancestors]);

  const options = useMemo(
    () => buildHistoryProjectOptions({ selectedHost, archived, active, observed }),
    [selectedHost, archived, active, observed],
  );
  return { options, catalogEquivalenceCounts };
}

export function HistoryProjectFilter({
  options,
  value,
  onSelect,
}: {
  options: readonly HistoryProjectOption[];
  value: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const anchorRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const handleOpen = useCallback(() => setOpen(true), []);
  const allProjectsLabel = t("sessions.projectFilter.all");
  const title = t("sessions.projectFilter.title");
  const selected = options.find(({ id }) => id === value);
  const label = selected?.label ?? allProjectsLabel;
  const comboboxOptions = useMemo(
    () => [{ id: ALL_PROJECTS_OPTION_ID, label: allProjectsLabel }, ...options],
    [allProjectsLabel, options],
  );
  const triggerStyle = useCallback(
    ({ hovered, pressed }: { hovered: boolean; pressed: boolean }) => [
      styles.trigger,
      hovered && styles.triggerHovered,
      pressed && styles.triggerPressed,
    ],
    [],
  );

  return (
    <>
      <ComboboxTrigger
        ref={anchorRef}
        style={triggerStyle}
        onPress={handleOpen}
        accessibilityRole="button"
        accessibilityLabel={`${title}: ${label}`}
        aria-expanded={open}
        testID="sessions-project-filter-trigger"
      >
        {selected ? (
          <ProjectIconView
            size={16}
            iconDataUri={null}
            initial={label.trim().charAt(0).toUpperCase() || "?"}
            projectViewKey={selected.id}
            textStyle={styles.iconText}
          />
        ) : (
          <ThemedFolder size={16} uniProps={mutedIconColor} />
        )}
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
      </ComboboxTrigger>
      <Combobox
        options={comboboxOptions}
        value={value}
        onSelect={onSelect}
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        searchable
        title={title}
        searchPlaceholder={t("sessions.projectFilter.searchPlaceholder")}
        emptyText={t("sessions.projectFilter.empty")}
        desktopPlacement="bottom-start"
        desktopMinWidth={240}
      />
    </>
  );
}

const styles = StyleSheet.create((theme) => {
  const geometry = createControlGeometry(theme);
  return {
    trigger: {
      ...geometry.buttonMd,
      flexDirection: "row",
      alignItems: "center",
      flexShrink: 1,
      minWidth: 0,
      maxWidth: "100%",
      borderWidth: theme.borderWidth[1],
      borderColor: theme.colors.borderAccent,
    },
    triggerHovered: {
      backgroundColor: theme.colors.surface1,
    },
    triggerPressed: {
      backgroundColor: theme.colors.surface2,
    },
    label: {
      ...geometry.buttonTextMd,
      color: theme.colors.foreground,
      flexShrink: 1,
      minWidth: 0,
    },
    iconText: {
      fontSize: theme.fontSize.sm,
      fontWeight: theme.fontWeight.medium,
    },
  };
});
