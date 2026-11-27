import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useOverlayRegistration, type KeyboardInputEvent } from "@/keyboard";
import { useAddHost } from "@/hosts/add-host";
import { Modal } from "@/components/ui/modal";
import { usePanelStore } from "@/stores/panel-store";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { router } from "expo-router";
import type { WorkspaceProjectDescriptorPayload } from "@getpaseo/protocol/messages";
import {
  ArrowLeft,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Plus,
  Search,
  Server,
} from "lucide-react-native";
import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type RefObject,
} from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import {
  EditingTextInput as TextInput,
  type EditingTextInputHandle,
} from "@/components/ui/text-input";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { GitHubIcon } from "@/components/icons/github-icon";
import {
  applyAvailableAddProjectHosts,
  backAddProjectPage,
  chooseAddProjectHost,
  currentAddProjectPage,
  moveAddProjectSelection,
  openAddProjectFlow,
  openDirectorySearchPage,
  openGithubLocationPage,
  openGithubSearchPage,
  openNewDirectoryNamePage,
  openNewDirectoryParentPage,
  setAddProjectActiveIndex,
  setAddProjectPageInput,
  setNewDirectoryName,
  updateCurrentAddProjectPage,
  type AddProjectFlowState,
  type AddProjectHost,
  type AddProjectPage,
  type GithubRepositoryChoice,
} from "@/add-project-flow/model";
import {
  buildAddProjectMethods,
  addProjectMethodEmptyText,
  buildCloneLocationOptions,
  buildManualGithubRepositoryChoices,
  buildSuggestedParentDirectories,
  filterAddProjectHosts,
  joinDirectoryPath,
  pathBaseName,
  type AddProjectMethodId,
} from "@/add-project-flow/options";
import {
  buildProjectPickerOptions,
  type ProjectPickerOption,
} from "@/components/project-picker-options";
import { Shortcut } from "@/components/ui/shortcut";
import { Button } from "@/components/ui/button";
import { useRevealActiveItem } from "@/components/ui/scroll-reveal";
import { useHardwareKeyboardPresent } from "@/keyboard";
import { getIsElectronRuntime } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { pickDirectory } from "@/desktop/pick-directory";
import { useFetchQuery } from "@/data/query";
import { getOpenProjectFailureReason, registerProjectDescriptor } from "@/hooks/open-project";
import { useIsLocalDaemon, useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useCloneGithubProject, useOpenProject } from "@/hooks/use-open-project";
import { OverlayLayerProvider, useGlobalOverlayLayer } from "@/lib/overlay-root";
import {
  useHosts,
  useHostRuntimeClient,
  useHostRuntimeConnectionStatuses,
} from "@/runtime/host-runtime";
import { useHostFeatureMap } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import { useRecommendedProjectPaths } from "@/stores/session-store-hooks";
import type { AddProjectFlowRequest } from "@/stores/add-project-flow-store";
import type { Theme } from "@/styles/theme";
import { shortenPath } from "@/utils/shorten-path";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";

interface AddProjectFlowProps {
  request: AddProjectFlowRequest;
  onClose: () => void;
}

interface FlowRowOption {
  id: string;
  title: string;
  subtitle: string | null;
  icon: ComponentType<{ size?: number; color?: string }>;
  disabled?: boolean;
  testID: string;
  select: () => void;
}

type GithubLocationPage = Extract<AddProjectPage, { kind: "github-location" }>;

interface FlowIconProps {
  icon: ComponentType<{ size?: number; color?: string }>;
  size?: number;
  color?: string;
}

function FlowIcon({ icon: Icon, size, color }: FlowIconProps) {
  return <Icon size={size} color={color} />;
}

const MutedFlowIcon = withUnistyles(FlowIcon, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedArrowLeft = withUnistyles(ArrowLeft);
const ThemedTextInput = withUnistyles(TextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const lastCloneParentByHost = new Map<string, string>();
const EMPTY_PATHS: string[] = [];
const NAVIGATION_HINT_KEYS = ["Up", "Down"];
const SELECT_HINT_KEYS = ["Enter"];
const ESCAPE_HINT_KEYS = ["Esc"];
const DIRECTORY_RETRY_TEST_ID = "add-project-flow-retry-directories";

function FlowBackButton({ onPress, label }: { onPress: () => void; label: string }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      style={styles.backButton}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID="add-project-flow-back"
    >
      {({ hovered, pressed }) => (
        <ThemedArrowLeft
          size={18}
          uniProps={hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping}
        />
      )}
    </Pressable>
  );
}

function methodIcon(method: AddProjectMethodId): FlowRowOption["icon"] {
  if (method === "github") return GitHubIcon;
  if (method === "browse") return FolderOpen;
  if (method === "new-directory") return FolderPlus;
  return Search;
}

function directoryOptionSubtitle(
  option: ProjectPickerOption,
  shortPath: string,
  t: TFunction,
): string | null {
  if (option.kind === "path") return t("addProject.openThisPath");
  if (shortPath === option.path) return null;
  return option.path;
}

function progressText(page: AddProjectPage, t: TFunction): string {
  if (page.kind === "github-location") return t("addProject.progress.cloning");
  if (page.kind === "new-directory-name") return t("addProject.progress.creating");
  return t("addProject.progress.adding");
}

function emptyText(page: AddProjectPage, host: AddProjectHost | null, t: TFunction): string {
  if (page.kind === "host") return t("addProject.noConnectedHosts");
  if (page.kind === "github-search") return t("addProject.methods.githubManual");
  if (page.kind === "method") return addProjectMethodEmptyText(host, t);
  return t("addProject.noMatchingOptions");
}

interface QueryErrorInput {
  githubFailed: boolean;
  githubAvailable: boolean | null;
  githubError: string | null;
}

function queryErrorText(input: QueryErrorInput, t: TFunction): string | null {
  if (input.githubFailed) return t("addProject.errors.searchGithub");
  if (input.githubError) return input.githubError;
  if (input.githubAvailable === false)
    return input.githubError ?? t("addProject.errors.githubSearchUnavailable");
  return null;
}

class DirectorySuggestionsResponseError extends Error {}

function pageHostId(page: AddProjectPage): string | null {
  return page.kind === "host" ? null : page.hostId;
}

function pageTitle(page: AddProjectPage, t: TFunction): string {
  switch (page.kind) {
    case "host":
      return t("addProject.hostTitle");
    case "method":
      return t("addProject.title");
    case "directory-search":
      return t("addProject.methods.search");
    case "github-search":
      return t("addProject.methods.github");
    case "github-location":
      return t("addProject.destinationTitle");
    case "new-directory-parent":
      return t("addProject.parentTitle");
    case "new-directory-name":
      return t("addProject.nameTitle");
  }
}

type AddProjectInputPage = Exclude<AddProjectPage, { kind: "method" }>;

function pagePlaceholder(page: AddProjectInputPage, t: TFunction): string {
  switch (page.kind) {
    case "host":
      return t("addProject.placeholders.host");
    case "directory-search":
      return t("addProject.placeholders.directory");
    case "github-search":
      return t("addProject.placeholders.github");
    case "github-location":
    case "new-directory-parent":
      return t("addProject.placeholders.parent");
    case "new-directory-name":
      return t("addProject.placeholders.name");
  }
}

function pageInput(page: AddProjectInputPage): string {
  return page.kind === "new-directory-name" ? page.name : page.query;
}

function pathTestId(path: string): string {
  return `add-project-flow-path-${encodeURIComponent(path)}`;
}

function FlowRow({
  option,
  active,
  activeItemRef,
  onRowLayout,
}: {
  option: FlowRowOption;
  active: boolean;
  activeItemRef: RefObject<View | null>;
  onRowLayout: () => void;
}) {
  const accessibilityState = useMemo(
    () => ({ disabled: option.disabled === true, selected: active }),
    [active, option.disabled],
  );
  const rowStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      (active || hovered || pressed) && styles.rowActive,
      option.disabled && styles.disabled,
    ],
    [active, option.disabled],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      disabled={option.disabled}
      ref={active ? activeItemRef : undefined}
      onLayout={active ? onRowLayout : undefined}
      onPress={option.select}
      style={rowStyle}
      testID={option.testID}
    >
      <View style={styles.iconSlot}>
        <MutedFlowIcon icon={option.icon} size={16} />
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {option.title}
        </Text>
        {option.subtitle ? (
          <Text style={styles.rowSubtitle} numberOfLines={1}>
            {option.subtitle}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function FlowHint({ keys, action }: { keys: string[]; action: string }) {
  const shortcutsAvailable = useHardwareKeyboardPresent();
  if (!shortcutsAvailable) return null;

  return (
    <View style={styles.footerHint}>
      <Shortcut keys={keys} textStyle={styles.footerKeyText} />
      <Text style={styles.footerAction}>{action}</Text>
    </View>
  );
}

function setPageStatus(
  state: AddProjectFlowState,
  kind: AddProjectPage["kind"],
  input: { isSubmitting?: boolean; error?: string | null },
): AddProjectFlowState {
  return updateCurrentAddProjectPage(state, (page) =>
    page.kind === kind ? { ...page, ...input } : page,
  );
}

// The product flow is intentionally one cohesive page-stack state machine.
// eslint-disable-next-line complexity
export function AddProjectFlow({ request, onClose }: AddProjectFlowProps) {
  const { t } = useTranslation();
  const addHost = useAddHost();
  const hosts = useHosts();
  const hostIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(hostIds);
  const projectAddByHost = useHostFeatureMap(hostIds, "projectAdd");
  // COMPAT(stableProjectIdentity): added in v0.1.109, remove gate after 2027-01-15.
  const stableProjectIdentityByHost = useHostFeatureMap(hostIds, "stableProjectIdentity");
  // COMPAT(projectGithubClone): added in v0.1.108, remove gate after 2027-01-15.
  const githubCloneByHost = useHostFeatureMap(hostIds, "projectGithubClone");
  // COMPAT(workspaceGithubRepositorySearch): added in v0.1.108, remove gate after 2027-01-15.
  const githubSearchByHost = useHostFeatureMap(hostIds, "workspaceGithubRepositorySearch");
  // COMPAT(projectCreateDirectory): added in v0.1.108, remove gate after 2027-01-15.
  const createDirectoryByHost = useHostFeatureMap(hostIds, "projectCreateDirectory");
  const localServerId = useLocalDaemonServerId();
  const availableHosts = useMemo<AddProjectHost[]>(
    () =>
      hosts.flatMap((host) => {
        if (connectionStatuses.get(host.serverId) !== "online") return [];
        const canAddProject =
          projectAddByHost.get(host.serverId) === true &&
          stableProjectIdentityByHost.get(host.serverId) === true;
        return [
          {
            serverId: host.serverId,
            label: host.label,
            canAddProject,
            canBrowse: canAddProject && getIsElectronRuntime() && localServerId === host.serverId,
            canCloneGithubRepositories: githubCloneByHost.get(host.serverId) === true,
            canSearchGithubRepositories: githubSearchByHost.get(host.serverId) === true,
            canCreateDirectory: createDirectoryByHost.get(host.serverId) === true,
          },
        ];
      }),
    [
      connectionStatuses,
      createDirectoryByHost,
      githubCloneByHost,
      githubSearchByHost,
      hosts,
      localServerId,
      projectAddByHost,
      stableProjectIdentityByHost,
    ],
  );
  const [state, setState] = useState(() =>
    openAddProjectFlow({
      hosts: availableHosts,
      ...(request.preferredHostId ? { preferredHostId: request.preferredHostId } : {}),
    }),
  );
  const page = currentAddProjectPage(state);
  const title = pageTitle(page, t);
  const inputLabel = page.kind === "method" ? undefined : pagePlaceholder(page, t);
  const hostId = pageHostId(page);
  const host = hostId ? state.hosts.find((candidate) => candidate.serverId === hostId) : null;
  const client = useHostRuntimeClient(hostId ?? "");
  const isLocalDaemon = useIsLocalDaemon(hostId ?? "");
  const recommendedPaths = useRecommendedProjectPaths(hostId);
  const openProject = useOpenProject(hostId);
  const cloneGithubProject = useCloneGithubProject(hostId);
  const upsertProject = useCallback(
    (
      targetServerId: string,
      project: Parameters<ReturnType<typeof getHostRuntimeStore>["acceptProjectSnapshot"]>[1],
    ) => {
      getHostRuntimeStore().acceptProjectSnapshot(targetServerId, project);
    },
    [],
  );
  const setHasHydratedWorkspaces = useSessionStore((store) => store.setHasHydratedWorkspaces);
  const inputRef = useRef<EditingTextInputHandle>(null);
  const resultsRef = useRef<ScrollView>(null);
  const submissionInFlightRef = useRef(false);
  const browseInFlightRef = useRef(false);
  const query = page.kind === "new-directory-name" || page.kind === "method" ? "" : page.query;
  const pageInputValueRef = useRef(page.kind === "method" ? "" : pageInput(page));
  pageInputValueRef.current = page.kind === "method" ? "" : pageInput(page);
  const [debouncedQuery, setDebouncedQuery] = useState(query);

  useEffect(() => {
    setState((current) =>
      applyAvailableAddProjectHosts(current, availableHosts, request.preferredHostId),
    );
  }, [availableHosts, request.preferredHostId]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    inputRef.current?.replaceText(pageInputValueRef.current);
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [page.kind]);

  const searchesDirectories =
    page.kind === "directory-search" ||
    page.kind === "github-location" ||
    page.kind === "new-directory-parent";
  const directoryQuery = useFetchQuery({
    queryKey: ["add-project-flow-directories", hostId, debouncedQuery],
    queryFn: async () => {
      if (!client) return { query: debouncedQuery, paths: [] as string[] };
      const payload = await client.getDirectorySuggestions({
        query: debouncedQuery,
        includeDirectories: true,
        includeFiles: false,
        limit: 30,
      });
      if (payload.error !== null) throw new DirectorySuggestionsResponseError(payload.error);
      return {
        query: debouncedQuery,
        paths:
          payload.entries?.flatMap((entry) => (entry.kind === "directory" ? [entry.path] : [])) ??
          [],
      };
    },
    enabled: Boolean(client && searchesDirectories && query === debouncedQuery),
    dataShape: "value",
    retry: false,
    staleTimeMs: 15_000,
  });
  const directoryError =
    client &&
    searchesDirectories &&
    query === debouncedQuery &&
    directoryQuery.isError &&
    !directoryQuery.isFetching
      ? (directoryQuery.error instanceof DirectorySuggestionsResponseError &&
          directoryQuery.error.message) ||
        t("addProject.errors.searchDirectories")
      : null;
  const { refetch: refetchDirectories } = directoryQuery;
  const retryDirectorySearch = useCallback(() => {
    void refetchDirectories();
  }, [refetchDirectories]);
  const githubQuery = useFetchQuery({
    queryKey: ["add-project-flow-github", hostId, debouncedQuery],
    queryFn: async () => {
      if (!client) throw new Error("Host is unavailable");
      const payload = await client.searchGithubRepositories({ query: debouncedQuery, limit: 30 });
      return { query: debouncedQuery, payload };
    },
    enabled: Boolean(client && page.kind === "github-search" && host?.canSearchGithubRepositories),
    dataShape: "value",
    retry: false,
    staleTimeMs: 15_000,
  });

  const handleBack = useCallback(() => {
    const previous = backAddProjectPage(state);
    if (previous) setState(previous);
    else onClose();
  }, [onClose, state]);

  const openNewWorkspaceForProject = useCallback(
    (serverId: string, project: WorkspaceProjectDescriptorPayload) => {
      onClose();
      usePanelStore.getState().showMobileAgent();
      router.push(
        buildNewWorkspaceRoute({
          serverId,
          projectId: project.projectId,
          sourceDirectory: project.projectRootPath,
          displayName: project.projectDisplayName,
        }),
      );
    },
    [onClose],
  );

  const openAddedProject = useCallback(
    async (path: string, sourceKind: "directory-search" | "method") => {
      if (!hostId || submissionInFlightRef.current) return;
      if (
        projectAddByHost.get(hostId) !== true ||
        stableProjectIdentityByHost.get(hostId) !== true
      ) {
        setState((current) =>
          setPageStatus(current, sourceKind, { error: t("addProject.methods.updateToAdd") }),
        );
        return;
      }
      submissionInFlightRef.current = true;
      setState((current) =>
        setPageStatus(current, sourceKind, { isSubmitting: true, error: null }),
      );
      try {
        const result = await openProject(path);
        if (result.ok) {
          openNewWorkspaceForProject(hostId, result.project);
          return;
        }
        const reason = getOpenProjectFailureReason(result);
        const fallbackKey =
          reason === "directory_not_found"
            ? "projectPicker.errors.directory_not_found"
            : "addProject.errors.add";
        const message = result.error?.trim() ? result.error : t(fallbackKey);
        setState((current) =>
          setPageStatus(current, sourceKind, { isSubmitting: false, error: message }),
        );
      } catch {
        setState((current) =>
          setPageStatus(current, sourceKind, {
            isSubmitting: false,
            error: t("addProject.errors.add"),
          }),
        );
      } finally {
        submissionInFlightRef.current = false;
      }
    },
    [
      hostId,
      openNewWorkspaceForProject,
      openProject,
      projectAddByHost,
      stableProjectIdentityByHost,
      t,
    ],
  );

  const browse = useCallback(async () => {
    if (!hostId || !isLocalDaemon || browseInFlightRef.current) return;
    browseInFlightRef.current = true;
    try {
      const path = await pickDirectory();
      if (path) await openAddedProject(path, "method");
    } catch {
      setState((current) =>
        setPageStatus(current, "method", { error: t("addProject.errors.browse") }),
      );
    } finally {
      browseInFlightRef.current = false;
    }
  }, [hostId, isLocalDaemon, openAddedProject, t]);

  const selectMethod = useCallback(
    (method: AddProjectMethodId) => {
      if (!hostId) return;
      if (method === "directory-search") {
        setState((current) => openDirectorySearchPage(current, hostId));
      } else if (method === "browse") {
        void browse();
      } else if (method === "github") {
        setState((current) => openGithubSearchPage(current, hostId));
      } else {
        setState((current) => openNewDirectoryParentPage(current, hostId));
      }
    },
    [browse, hostId],
  );

  const directoryPaths = useMemo(
    () => (directoryQuery.data?.query === query ? directoryQuery.data.paths : EMPTY_PATHS),
    [directoryQuery.data, query],
  );
  const showDirectPathOnError = page.kind === "directory-search" && directoryError !== null;
  const pathOptions = useMemo(
    () =>
      buildProjectPickerOptions({
        recommendedPaths: showDirectPathOnError ? EMPTY_PATHS : recommendedPaths,
        serverPaths: showDirectPathOnError ? EMPTY_PATHS : directoryPaths,
        query,
      }),
    [directoryPaths, query, recommendedPaths, showDirectPathOnError],
  );
  const cloneRepository = useCallback(
    async (locationPage: GithubLocationPage, parentPath: string) => {
      if (submissionInFlightRef.current) return;
      submissionInFlightRef.current = true;
      setState((current) =>
        setPageStatus(current, "github-location", { isSubmitting: true, error: null }),
      );
      try {
        const result = await cloneGithubProject(
          locationPage.repository.cloneUrl,
          parentPath,
          locationPage.repository.cloneProtocol,
        );
        if (result.ok) {
          lastCloneParentByHost.set(locationPage.hostId, parentPath);
          openNewWorkspaceForProject(locationPage.hostId, result.project);
          return;
        }
        setState((current) =>
          setPageStatus(current, "github-location", {
            isSubmitting: false,
            error: result.error ?? t("addProject.errors.clone"),
          }),
        );
      } catch (error) {
        setState((current) =>
          setPageStatus(current, "github-location", {
            isSubmitting: false,
            error: error instanceof Error ? error.message : t("addProject.errors.clone"),
          }),
        );
      } finally {
        submissionInFlightRef.current = false;
      }
    },
    [cloneGithubProject, openNewWorkspaceForProject, t],
  );
  const rows = useMemo<FlowRowOption[]>(() => {
    if (page.kind === "host") {
      const choices = filterAddProjectHosts(state.hosts, page.query).map<FlowRowOption>(
        (choice) => ({
          id: choice.serverId,
          title: choice.label,
          subtitle: choice.serverId,
          icon: Server,
          testID: `add-project-flow-host-${choice.serverId}`,
          select: () => setState((current) => chooseAddProjectHost(current, choice.serverId)),
        }),
      );
      if (state.hosts.length === 0) {
        choices.push({
          id: "add-host",
          title: t("settings.addHost"),
          subtitle: t("addProject.noConnectedHosts"),
          icon: Plus,
          testID: "add-project-flow-add-host",
          select: () => {
            // The native project Modal must release its window before the root sheet opens.
            onClose();
            addHost();
          },
        });
      }
      return choices;
    }
    if (page.kind === "method") {
      if (!host) return [];
      return buildAddProjectMethods(host, t).map((method) => ({
        id: method.id,
        title: method.label,
        subtitle: method.description,
        icon: methodIcon(method.id),
        disabled: method.disabled,
        testID: `add-project-flow-method-${method.id}`,
        select: () => selectMethod(method.id),
      }));
    }
    if (page.kind === "directory-search") {
      return pathOptions.map((option) => {
        const shortPath = shortenPath(option.path);
        return {
          id: option.path,
          title: shortPath,
          subtitle: directoryOptionSubtitle(option, shortPath, t),
          icon: Folder,
          testID: pathTestId(option.path),
          select: () => void openAddedProject(option.path, "directory-search"),
        };
      });
    }
    if (page.kind === "github-search") {
      const search = githubQuery.data?.query === page.query ? githubQuery.data.payload : null;
      const repositories = search?.repositories ?? [];
      const normalizedQuery = page.query.trim().toLowerCase();
      const hasExactSearchResult = repositories.some(
        (repository) =>
          repository.nameWithOwner.toLowerCase() === normalizedQuery ||
          repository.cloneUrl.toLowerCase() === normalizedQuery,
      );
      const manualRepositories = hasExactSearchResult
        ? []
        : buildManualGithubRepositoryChoices(page.query, t);
      const repositoryChoices: GithubRepositoryChoice[] = [...manualRepositories, ...repositories];
      return repositoryChoices.map((repository) => ({
        id: repository.id,
        title: repository.cloneProtocol
          ? t("addProject.repositoryWithProtocol", {
              repository: repository.nameWithOwner,
              protocol: repository.cloneProtocol.toUpperCase(),
            })
          : repository.nameWithOwner,
        subtitle: repository.description,
        icon: GitHubIcon,
        testID: `add-project-flow-repository-${repository.id}`,
        select: () =>
          setState((current) => openGithubLocationPage(current, page.hostId, repository)),
      }));
    }
    if (page.kind === "github-location") {
      const repositoryName = pathBaseName(page.repository.nameWithOwner);
      const lastParent = lastCloneParentByHost.get(page.hostId);
      const parents = buildSuggestedParentDirectories(recommendedPaths);
      const orderedParents = lastParent
        ? [lastParent, ...parents.filter((parent) => parent !== lastParent)]
        : parents;
      const filteredParents = buildProjectPickerOptions({
        recommendedPaths: orderedParents,
        serverPaths: directoryPaths,
        query: page.query,
      }).map((option) => option.path);
      return buildCloneLocationOptions(
        {
          parents: filteredParents,
          repositoryName,
          existingPaths: [...recommendedPaths, ...directoryPaths],
        },
        t,
      ).map((option) => ({
        id: option.id,
        title: shortenPath(option.displayPath),
        subtitle: option.secondaryText,
        icon: HardDrive,
        disabled: option.disabled,
        testID: pathTestId(option.displayPath),
        select: () => void cloneRepository(page, option.path),
      }));
    }
    if (page.kind === "new-directory-parent") {
      return pathOptions.map((option) => ({
        id: option.path,
        title: shortenPath(option.path),
        subtitle: option.kind === "path" ? t("addProject.useThisParent") : option.path,
        icon: Folder,
        testID: pathTestId(option.path),
        select: () =>
          setState((current) => openNewDirectoryNamePage(current, page.hostId, option.path)),
      }));
    }
    return [];
  }, [
    cloneRepository,
    directoryPaths,
    githubQuery.data,
    host,
    addHost,
    onClose,
    openAddedProject,
    page,
    pathOptions,
    recommendedPaths,
    selectMethod,
    state.hosts,
    t,
  ]);

  const activeIndex = rows.length === 0 ? 0 : Math.min(page.activeIndex, rows.length - 1);
  const rowListKey = useMemo(() => rows.map((row) => row.id).join("\u0000"), [rows]);
  const { activeItemRef, contentRef, onItemLayout, onViewportLayout, onScroll } =
    useRevealActiveItem({
      activeIndex,
      listKey: rowListKey,
      scrollRef: resultsRef,
    });
  const createDirectory = useCallback(async () => {
    if (page.kind !== "new-directory-name" || !client) return;
    const name = page.name.trim();
    if (!name || name === "." || name === ".." || /[\\/]/.test(name)) {
      setState((current) =>
        setPageStatus(current, "new-directory-name", { error: t("addProject.errors.enterName") }),
      );
      return;
    }
    if (submissionInFlightRef.current) return;
    submissionInFlightRef.current = true;
    setState((current) =>
      setPageStatus(current, "new-directory-name", { isSubmitting: true, error: null }),
    );
    try {
      const payload = await client.createProjectDirectory({
        parentPath: page.parentPath,
        name,
      });
      if (payload.error || !payload.project) {
        setState((current) =>
          setPageStatus(current, "new-directory-name", {
            isSubmitting: false,
            error: payload.error ?? t("addProject.errors.create"),
          }),
        );
        return;
      }
      registerProjectDescriptor({
        serverId: page.hostId,
        project: payload.project,
        upsertProject,
        setHasHydratedWorkspaces,
      });
      openNewWorkspaceForProject(page.hostId, payload.project);
    } catch {
      setState((current) =>
        setPageStatus(current, "new-directory-name", {
          isSubmitting: false,
          error: t("addProject.errors.create"),
        }),
      );
    } finally {
      submissionInFlightRef.current = false;
    }
  }, [client, openNewWorkspaceForProject, page, setHasHydratedWorkspaces, t, upsertProject]);

  const submitActive = useCallback(() => {
    if (page.kind === "new-directory-name") {
      void createDirectory();
      return;
    }
    const option = rows[activeIndex];
    if (directoryError && (!showDirectPathOnError || !option)) {
      retryDirectorySearch();
      return;
    }
    if (searchesDirectories && (query !== debouncedQuery || directoryQuery.isFetching)) return;
    if (option && !option.disabled) option.select();
  }, [
    activeIndex,
    createDirectory,
    debouncedQuery,
    directoryError,
    directoryQuery.isFetching,
    page.kind,
    query,
    retryDirectorySearch,
    rows,
    searchesDirectories,
    showDirectPathOnError,
  ]);

  const handleKey = useCallback(
    (key: string): boolean => {
      if (key === "Escape") {
        handleBack();
        return true;
      }
      if (key === "Enter") {
        submitActive();
        return true;
      }
      if (key !== "ArrowDown" && key !== "ArrowUp") return false;
      const next = moveAddProjectSelection(
        activeIndex,
        rows.map((row) => row.disabled !== true),
        key === "ArrowDown" ? "next" : "previous",
      );
      setState((current) => setAddProjectActiveIndex(current, next));
      return true;
    },
    [activeIndex, handleBack, rows, submitActive],
  );

  const modalLayer = useGlobalOverlayLayer("modal", true);
  const handleOverlayKeyDown = useCallback(
    (event: KeyboardInputEvent) => {
      if (
        isWeb &&
        event.key === "Enter" &&
        document.activeElement?.closest(`[data-testid="${DIRECTORY_RETRY_TEST_ID}"]`)
      ) {
        return false;
      }
      if (!handleKey(event.key)) return false;
      event.preventDefault();
      return true;
    },
    [handleKey],
  );
  const setOverlayScope = useOverlayRegistration({
    keys: ["Escape", "Enter", "ArrowUp", "ArrowDown"],
    active: true,
    layer: modalLayer,
    onKeyDown: handleOverlayKeyDown,
  });

  const handleInputChange = useCallback((value: string) => {
    setState((current) =>
      currentAddProjectPage(current).kind === "new-directory-name"
        ? setNewDirectoryName(current, value)
        : setAddProjectPageInput(current, value),
    );
  }, []);
  const isSubmitting = "isSubmitting" in page && page.isSubmitting;
  const currentGithubSearch =
    page.kind === "github-search" && githubQuery.data?.query === page.query
      ? githubQuery.data.payload
      : null;
  const loading =
    (searchesDirectories && (query !== debouncedQuery || directoryQuery.isFetching)) ||
    (page.kind === "github-search" &&
      host?.canSearchGithubRepositories === true &&
      (query !== debouncedQuery || githubQuery.isFetching));
  const queryError =
    directoryError ??
    queryErrorText(
      {
        githubFailed: page.kind === "github-search" && githubQuery.isError,
        githubAvailable: currentGithubSearch?.available ?? null,
        githubError: currentGithubSearch?.error ?? null,
      },
      t,
    );
  const preview =
    page.kind === "new-directory-name" && page.name.trim()
      ? joinDirectoryPath(page.parentPath, page.name.trim())
      : null;

  const modal = (
    <Modal visible transparent animationType="fade" onRequestClose={isWeb ? undefined : handleBack}>
      <View style={styles.overlay} testID="add-project-flow">
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t("common.actions.close")}
          testID="add-project-flow-backdrop"
        />
        <View
          ref={setOverlayScope}
          style={styles.panel}
          testID={`add-project-flow-page-${page.kind}`}
          accessibilityLabel={title}
        >
          <View style={styles.header}>
            <View style={styles.titleRow}>
              {state.pages.length > 1 ? (
                <FlowBackButton onPress={handleBack} label={t("common.actions.back")} />
              ) : null}
              <View style={styles.titleGroup} testID="add-project-flow-title">
                <Text style={styles.title} numberOfLines={1}>
                  {title}
                </Text>
                {host ? (
                  <Text style={styles.hostContext} numberOfLines={1}>
                    {host.label}
                  </Text>
                ) : null}
              </View>
            </View>
            {page.kind !== "method" ? (
              <ThemedTextInput
                ref={inputRef}
                initialValue={pageInput(page)}
                onChangeText={handleInputChange}
                onSubmitEditing={isWeb ? undefined : submitActive}
                placeholder={inputLabel}
                accessibilityLabel={inputLabel}
                style={styles.input}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!isSubmitting}
                returnKeyType="go"
                testID="add-project-flow-input"
              />
            ) : null}
          </View>
          <ScrollView
            ref={resultsRef}
            style={styles.results}
            keyboardShouldPersistTaps="always"
            onLayout={onViewportLayout}
            onScroll={onScroll}
            scrollEventThrottle={16}
            showsVerticalScrollIndicator={false}
            testID="add-project-flow-results"
          >
            <View ref={contentRef} collapsable={false} style={styles.resultsContent}>
              {preview ? (
                <Text style={styles.preview} testID="add-project-flow-path-preview">
                  {shortenPath(preview)}
                </Text>
              ) : null}
              {isSubmitting ? (
                <Text style={styles.stateText} testID="add-project-flow-progress">
                  {progressText(page, t)}
                </Text>
              ) : null}
              {!isSubmitting && page.error ? (
                <Text style={styles.errorText} testID="add-project-flow-error">
                  {page.error}
                </Text>
              ) : null}
              {!isSubmitting && queryError ? (
                <Text style={styles.errorText} testID="add-project-flow-query-error">
                  {queryError}
                </Text>
              ) : null}
              {!isSubmitting && directoryError ? (
                <View style={styles.retryRow}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onPress={retryDirectorySearch}
                    testID={DIRECTORY_RETRY_TEST_ID}
                  >
                    {t("common.actions.retry")}
                  </Button>
                </View>
              ) : null}
              {!isSubmitting && loading ? (
                <Text style={styles.stateText} testID="add-project-flow-loading">
                  {t("common.states.loading")}
                </Text>
              ) : null}
              {!isSubmitting &&
              (!loading || page.kind === "github-search") &&
              (!queryError || page.kind === "github-search" || showDirectPathOnError)
                ? rows.map((option, index) => (
                    <FlowRow
                      key={option.id}
                      option={option}
                      activeItemRef={activeItemRef}
                      active={index === activeIndex}
                      onRowLayout={onItemLayout}
                    />
                  ))
                : null}
              {!isSubmitting &&
              !loading &&
              !queryError &&
              rows.length === 0 &&
              page.kind !== "new-directory-name" ? (
                <Text style={styles.stateText} testID="add-project-flow-empty">
                  {emptyText(page, host ?? null, t)}
                </Text>
              ) : null}
            </View>
          </ScrollView>
          <View style={styles.footer} testID="add-project-flow-footer">
            <FlowHint keys={NAVIGATION_HINT_KEYS} action={t("addProject.navigate")} />
            <FlowHint keys={SELECT_HINT_KEYS} action={t("common.actions.select")} />
            <FlowHint
              keys={ESCAPE_HINT_KEYS}
              action={state.pages.length > 1 ? t("common.actions.back") : t("common.actions.close")}
            />
          </View>
        </View>
      </View>
    </Modal>
  );

  return createElement(OverlayLayerProvider, { layer: modalLayer }, modal);
}

const styles = StyleSheet.create((theme) => ({
  overlay: {
    flex: 1,
    justifyContent: "flex-start",
    alignItems: "center",
    paddingTop: theme.spacing[12],
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
  },
  panel: {
    width: 640,
    maxWidth: "92%",
    maxHeight: "80%",
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
    ...theme.shadow.lg,
  },
  header: {
    flexShrink: 0,
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    gap: theme.spacing[2],
  },
  titleRow: {
    minHeight: theme.iconSize.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  backButton: {
    width: 18,
    height: theme.iconSize.lg,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  titleGroup: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
  },
  title: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  hostContext: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  input: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    paddingVertical: theme.spacing[1],
    outlineStyle: "none",
  } as object,
  results: { flexGrow: 0, flexShrink: 1, minHeight: 0 },
  resultsContent: { paddingVertical: theme.spacing[2] },
  retryRow: { alignItems: "flex-start", paddingHorizontal: theme.spacing[4] },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  rowActive: { backgroundColor: theme.colors.surface1 },
  disabled: { opacity: theme.opacity[50] },
  iconSlot: { width: 18, alignItems: "center" },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  rowSubtitle: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, marginTop: 2 },
  preview: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  stateText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  footer: {
    flexShrink: 0,
    flexDirection: "row",
    gap: theme.spacing[4],
    alignItems: "center",
    flexWrap: "wrap",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  footerHint: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  footerKeyText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  footerAction: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
