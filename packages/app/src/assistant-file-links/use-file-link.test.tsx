/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import React, { useCallback, useMemo, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToastApi } from "@/components/toast-host";
import type { InlinePathTarget } from "./parse";
import { createInlinePathOpener } from "./path-open";
import { AssistantFileLinkResolverProvider, type AssistantFileLinkDaemonClient } from "./provider";
import type { DirectorySuggestionResult } from "./resolver";
import { useFileLink } from "./use-file-link";
import type { OpenFileDisposition } from "@/workspace/file-open";

vi.mock("@/utils/open-external-url", () => ({
  openExternalUrl: vi.fn(async () => {}),
}));

const SOURCE = {
  href: "http://dumm.md",
  text: "dumm.md",
  markup: "linkify",
};

function resolvedSuggestions(
  entries: DirectorySuggestionResult["entries"],
): DirectorySuggestionResult {
  return { entries, error: null };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

/**
 * Resolves a pending lookup and waits until React Query has delivered the result. It delivers on a
 * timer, which would otherwise fire after the test, when jsdom is gone.
 */
async function resolveLookupAndDeliver(
  lookup: ReturnType<typeof createDeferred<DirectorySuggestionResult>>,
  result: DirectorySuggestionResult,
): Promise<void> {
  await act(async () => {
    lookup.resolve(result);
    await lookup.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

interface OpenedFile {
  target: InlinePathTarget;
  disposition: OpenFileDisposition;
}

interface TestClient {
  listDirectory?: (cwd: string, path: string) => Promise<unknown>;
  getDirectorySuggestions: (input: {
    query: string;
    cwd: string;
    includeFiles: true;
    includeDirectories: false;
    matchMode: "suffix";
    limit: number;
  }) => Promise<DirectorySuggestionResult>;
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function createToast(): ToastApi {
  return {
    show: vi.fn<ToastApi["show"]>(),
    copied: vi.fn<ToastApi["copied"]>(),
    error: vi.fn<ToastApi["error"]>(),
  };
}

function createWrapper(input: {
  client?: TestClient;
  openedFiles: OpenedFile[];
  toast?: ToastApi;
  queryClient?: QueryClient;
  relativePathBase?: string;
  onOpen?: (target: InlinePathTarget, disposition: OpenFileDisposition) => void;
}) {
  const queryClient = input.queryClient ?? createQueryClient();
  return function Wrapper({ children }: { children: ReactNode }) {
    const openWorkspaceFile = useCallback(
      (target: InlinePathTarget, disposition: OpenFileDisposition) => {
        input.openedFiles.push({ target, disposition });
        input.onOpen?.(target, disposition);
      },
      [],
    );

    return (
      <QueryClientProvider client={queryClient}>
        <AssistantFileLinkResolverProvider
          client={input.client}
          serverId="server-1"
          workspaceRoot="/Users/test/project"
          relativePathBase={input.relativePathBase}
          onOpenWorkspaceFile={openWorkspaceFile}
          toast={input.toast}
        >
          {children}
        </AssistantFileLinkResolverProvider>
      </QueryClientProvider>
    );
  };
}

describe("useFileLink", () => {
  // Lookups resolve after a test's last assertion; an unmounted hook cannot re-render
  // once jsdom is torn down.
  afterEach(() => {
    cleanup();
  });

  it("returns the same object across no-op parent rerenders", () => {
    const getDirectorySuggestions = vi.fn(async () => resolvedSuggestions([]));
    const queryClient = createQueryClient();
    const Provider = AssistantFileLinkResolverProvider as React.ComponentType<
      Omit<React.ComponentProps<typeof AssistantFileLinkResolverProvider>, "children"> & {
        children?: ReactNode;
      }
    >;

    function ChurningProviderWrapper({ children }: { children: ReactNode }) {
      return React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          Provider,
          {
            client: { getDirectorySuggestions },
            serverId: "server-1",
            workspaceRoot: "/Users/test/project",
            onOpenWorkspaceFile: () => {},
            toast: createToast(),
          },
          children,
        ),
      );
    }

    const { result, rerender } = renderHook(() => useFileLink({ ...SOURCE }), {
      wrapper: ChurningProviderWrapper,
    });
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
    expect(result.current.onHoverIn).toBe(first.onHoverIn);
    expect(result.current.onPress).toBe(first.onPress);
    expect(result.current.open).toBe(first.open);
  });

  it("does not cache unresolved lookups forever", async () => {
    const getDirectorySuggestions = vi
      .fn()
      .mockResolvedValueOnce(resolvedSuggestions([]))
      .mockResolvedValueOnce(resolvedSuggestions([{ path: "docs/dumm.md", kind: "file" }]));
    const openedFiles: OpenedFile[] = [];
    const toast = createToast();
    const { result } = renderHook(() => useFileLink(SOURCE), {
      wrapper: createWrapper({
        client: { getDirectorySuggestions },
        openedFiles,
        toast,
      }),
    });

    act(() => {
      result.current.onPress();
    });
    await waitFor(() => {
      expect(toast.show).toHaveBeenCalledWith("No file found for dumm.md", {
        variant: "error",
        testID: "assistant-file-link-not-found-toast",
      });
    });

    act(() => {
      result.current.onPress();
    });
    await waitFor(() => {
      expect(openedFiles).toEqual([
        {
          target: {
            raw: "dumm.md",
            path: "/Users/test/project/docs/dumm.md",
            lineStart: undefined,
            lineEnd: undefined,
            workspaceLookupComplete: true,
          },
          disposition: "preferred",
        },
      ]);
    });
    expect(getDirectorySuggestions).toHaveBeenCalledTimes(2);
  });

  it("click retries after hover prefetch fails", async () => {
    const getDirectorySuggestions = vi
      .fn()
      .mockRejectedValueOnce(new Error("daemon unavailable"))
      .mockResolvedValueOnce(resolvedSuggestions([{ path: "docs/dumm.md", kind: "file" }]));
    const openedFiles: OpenedFile[] = [];
    const { result } = renderHook(() => useFileLink(SOURCE), {
      wrapper: createWrapper({
        client: { getDirectorySuggestions },
        openedFiles,
      }),
    });

    act(() => {
      result.current.onHoverIn();
    });
    await waitFor(() => {
      expect(getDirectorySuggestions).toHaveBeenCalledTimes(1);
    });

    act(() => {
      result.current.onPress();
    });
    await waitFor(() => {
      expect(openedFiles).toHaveLength(1);
    });
    expect(getDirectorySuggestions).toHaveBeenCalledTimes(2);
  });

  it("dedupes two links pointing at the same source", async () => {
    const deferred = createDeferred<DirectorySuggestionResult>();
    const getDirectorySuggestions = vi.fn(() => deferred.promise);
    const openedFiles: OpenedFile[] = [];
    const { result } = renderHook(
      () => ({
        first: useFileLink(SOURCE),
        second: useFileLink({ href: "dumm.md:9-12", markup: "linkify" }),
      }),
      {
        wrapper: createWrapper({
          client: { getDirectorySuggestions },
          openedFiles,
        }),
      },
    );

    act(() => {
      result.current.first.onHoverIn();
      result.current.second.onHoverIn();
    });
    await waitFor(() => {
      expect(getDirectorySuggestions).toHaveBeenCalledTimes(1);
    });
    expect(result.current.first.tooltipPath).toBe("dumm.md");
    expect(result.current.first.tooltipDetail).toBe("Looking up…");
    expect(result.current.second.tooltipPath).toBe("dumm.md:9-12");
    deferred.resolve(resolvedSuggestions([{ path: "docs/dumm.md", kind: "file" }]));
    await waitFor(() => {
      expect(result.current.first.target?.path).toBe("/Users/test/project/docs/dumm.md");
      expect(result.current.second.target?.path).toBe("/Users/test/project/docs/dumm.md");
      expect(result.current.second.tooltipPath).toBe("docs/dumm.md:9-12");
    });
  });

  it.each([false, true])(
    "keeps the original reference when a lookup is unconfirmed (offline: %s)",
    async (offline) => {
      const client = offline
        ? undefined
        : { getDirectorySuggestions: async () => resolvedSuggestions([]) };
      const { result } = renderHook(() => useFileLink(SOURCE), {
        wrapper: createWrapper({ client, openedFiles: [] }),
      });
      act(() => result.current.onHoverIn());
      await waitFor(() => {
        expect(result.current).toMatchObject({
          target: null,
          tooltipPath: "dumm.md",
          tooltipDetail: "Could not locate in this workspace",
        });
      });
    },
  );

  it("shows the fallback while disconnected and looks up again on the same client after reconnecting", async () => {
    type State = ReturnType<NonNullable<AssistantFileLinkDaemonClient["getConnectionState"]>>;
    let state: State = { status: "connected" };
    const listeners = new Set<(next: State) => void>();
    const stale = createDeferred<DirectorySuggestionResult>();
    const suggestions = vi
      .fn()
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValue(resolvedSuggestions([{ path: "new/dumm.md", kind: "file" }]));
    const client = {
      getConnectionState: () => state,
      subscribeConnectionStatus: (listener: (next: State) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      getDirectorySuggestions: suggestions,
    };
    const setConnection = (next: State) => {
      state = next;
      for (const listener of listeners) listener(state);
    };
    const openedFiles: OpenedFile[] = [];
    const { result } = renderHook(() => useFileLink(SOURCE), {
      wrapper: createWrapper({ client, openedFiles }),
    });
    act(() => result.current.onPress());
    expect(suggestions).toHaveBeenCalledTimes(1);
    act(() => setConnection({ status: "connecting", attempt: 1 }));
    expect(result.current.tooltipDetail).toBe("Could not locate in this workspace");
    act(() => result.current.onHoverIn());
    expect(suggestions).toHaveBeenCalledTimes(1);
    act(() => setConnection({ status: "connected" }));
    act(() => result.current.onHoverIn());
    await waitFor(() => expect(result.current.tooltipPath).toBe("new/dumm.md"));
    await resolveLookupAndDeliver(
      stale,
      resolvedSuggestions([{ path: "old/dumm.md", kind: "file" }]),
    );
    expect(openedFiles).toEqual([]);
    expect(result.current.tooltipPath).toBe("new/dumm.md");
    act(() => result.current.onPress());
    await waitFor(() =>
      expect(openedFiles[0]?.target.path).toBe("/Users/test/project/new/dumm.md"),
    );
    expect(suggestions).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["README.md", undefined, "./README.md", "/Users/test/project/README.md"],
    ["guide.md", "/Users/test/project/docs", "docs/guide.md", "/Users/test/project/docs/guide.md"],
  ] as const)(
    "keeps the original authored path when %s only has a suffix match",
    async (href, base, query, path) => {
      const getDirectorySuggestions = vi.fn(async () =>
        resolvedSuggestions([{ path: "other/" + query.replace(/^\.\//, ""), kind: "file" }]),
      );
      const open = vi.fn();
      const { result } = renderHook(() => useFileLink({ href }), {
        wrapper: createWrapper({
          client: { getDirectorySuggestions },
          openedFiles: [],
          onOpen: open,
          relativePathBase: base,
        }),
      });
      act(() => result.current.onPress());
      await waitFor(() =>
        expect(open).toHaveBeenCalledWith(expect.objectContaining({ path }), "preferred"),
      );
      expect(result.current.tooltipPath).toBe(href);
      expect(result.current.tooltipDetail).toBe("Could not locate in this workspace");
      expect(getDirectorySuggestions).toHaveBeenCalledWith(expect.objectContaining({ query }));
      getDirectorySuggestions.mockResolvedValue(
        resolvedSuggestions([{ path: query.replace(/^\.\//, ""), kind: "file" }]),
      );
      act(() => result.current.onHoverIn());
      await waitFor(() => expect(result.current.target?.path).toBe(path));
    },
  );

  it("shows and opens the exact relative file before suffix matches", async () => {
    const getDirectorySuggestions = vi.fn(async () =>
      resolvedSuggestions([
        { path: "schema/x.md", kind: "file" },
        { path: "repo-a/schema/x.md", kind: "file" },
      ]),
    );
    const listDirectory = vi.fn(async () => ({}));
    const openedFiles: OpenedFile[] = [];
    const { result } = renderHook(() => useFileLink({ href: "schema/x.md:12-14" }), {
      wrapper: createWrapper({ client: { getDirectorySuggestions, listDirectory }, openedFiles }),
    });
    act(() => {
      result.current.onHoverIn();
      result.current.onPress();
    });
    await waitFor(() => {
      expect(result.current.tooltipPath).toBe("schema/x.md:12-14");
      expect(result.current.tooltipDetail).toBe("Multiple matches. Opens this path by default.");
      expect(openedFiles[0]?.target).toMatchObject({
        path: "/Users/test/project/schema/x.md",
        lineStart: 12,
        lineEnd: 14,
      });
    });
    expect(getDirectorySuggestions).toHaveBeenCalledTimes(1);
    expect(listDirectory).not.toHaveBeenCalled();
  });

  it("keeps an exact dotted directory ahead of a file with the same suffix", async () => {
    const getDirectorySuggestions = vi.fn(async () =>
      resolvedSuggestions([{ path: "repo-a/schema/docs.md", kind: "file" }]),
    );
    const listDirectory = vi.fn(async () => ({}));
    const openedFiles: OpenedFile[] = [];
    const { result } = renderHook(() => useFileLink({ href: "schema/docs.md" }), {
      wrapper: createWrapper({ client: { getDirectorySuggestions, listDirectory }, openedFiles }),
    });
    act(() => result.current.onHoverIn());
    await waitFor(() =>
      expect(result.current.target?.path).toBe("/Users/test/project/schema/docs.md"),
    );
    act(() => result.current.onPress());
    await waitFor(() =>
      expect(openedFiles[0]?.target.path).toBe("/Users/test/project/schema/docs.md"),
    );
    expect(result.current.tooltipPath).toBe("schema/docs.md");
    expect(listDirectory).toHaveBeenCalledExactlyOnceWith("/Users/test/project", "schema/docs.md");
    expect(getDirectorySuggestions).toHaveBeenCalledTimes(1);
  });

  it("refreshes an expired hover result before opening a file", async () => {
    const dateNow = vi.spyOn(Date, "now");
    const queryClient = createQueryClient();
    const getDirectorySuggestions = vi
      .fn()
      .mockResolvedValueOnce(resolvedSuggestions([{ path: "old/dumm.md", kind: "file" }]))
      .mockResolvedValueOnce(resolvedSuggestions([{ path: "new/dumm.md", kind: "file" }]));
    const openedFiles: OpenedFile[] = [];
    const { result } = renderHook(() => useFileLink(SOURCE), {
      wrapper: createWrapper({ client: { getDirectorySuggestions }, openedFiles, queryClient }),
    });
    try {
      act(() => result.current.onHoverIn());
      await waitFor(() => expect(result.current.tooltipPath).toBe("old/dumm.md"));
      dateNow.mockReturnValue(Date.now() + 46_000);
      act(() => result.current.onPress());
      await waitFor(() =>
        expect(openedFiles[0]?.target.path).toBe("/Users/test/project/new/dumm.md"),
      );
      expect(getDirectorySuggestions).toHaveBeenCalledTimes(2);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("hover then click uses the prefetched result", async () => {
    const getDirectorySuggestions = vi.fn(async () =>
      resolvedSuggestions([{ path: "docs/dumm.md", kind: "file" }]),
    );
    const openedFiles: OpenedFile[] = [];
    const { result } = renderHook(() => useFileLink(SOURCE), {
      wrapper: createWrapper({
        client: { getDirectorySuggestions },
        openedFiles,
      }),
    });

    act(() => {
      result.current.onHoverIn();
    });
    await waitFor(() => {
      expect(result.current.target?.path).toBe("/Users/test/project/docs/dumm.md");
    });

    act(() => {
      result.current.onPress();
    });
    await waitFor(() => {
      expect(openedFiles).toHaveLength(1);
    });
    expect(getDirectorySuggestions).toHaveBeenCalledTimes(1);
  });

  it("opens a resolved bare reference without the chat opener starting another suffix lookup", async () => {
    const workspaceRoot = "/Users/test/project";
    const getDirectorySuggestions = vi.fn(async () =>
      resolvedSuggestions([{ path: "docs/dumm.md", kind: "file" }]),
    );
    const listDirectory = vi.fn(async () => {
      throw new Error("Not a directory");
    });
    const client = { getDirectorySuggestions, listDirectory };
    const openFile = vi.fn();
    const opener = createInlinePathOpener({
      workspaceRoot,
      resolveRelativeFiles: true,
      client,
      openFile,
      openDirectory: vi.fn(),
      openOutsideDirectory: vi.fn(),
    });
    const { result } = renderHook(
      () => useFileLink({ href: "dumm.md:4-7", sourceType: "inline-code" }),
      { wrapper: createWrapper({ client, openedFiles: [], onOpen: opener.open }) },
    );
    act(() => result.current.onHoverIn());
    await waitFor(() => expect(result.current.tooltipPath).toBe("docs/dumm.md:4-7"));
    act(() => result.current.onPress());
    await waitFor(() =>
      expect(openFile).toHaveBeenCalledExactlyOnceWith(
        { path: "docs/dumm.md", lineStart: 4, lineEnd: 7 },
        "preferred",
      ),
    );
    expect(getDirectorySuggestions).toHaveBeenCalledTimes(1);
  });

  it("does not open a stale result after the workspace changes", async () => {
    const deferred = createDeferred<DirectorySuggestionResult>();
    const getDirectorySuggestions = vi.fn(() => deferred.promise);
    const openedFiles: OpenedFile[] = [];
    const queryClient = createQueryClient();

    function Wrapper({ children }: { children: ReactNode }) {
      const [workspaceRoot, setWorkspaceRoot] = useState("/Users/test/project");
      const client = useMemo(() => ({ getDirectorySuggestions }), []);
      const openWorkspaceFile = useCallback(
        (target: InlinePathTarget, disposition: OpenFileDisposition) => {
          openedFiles.push({ target, disposition });
        },
        [],
      );
      return (
        <QueryClientProvider client={queryClient}>
          <AssistantFileLinkResolverProvider
            client={client}
            serverId="server-1"
            workspaceRoot={workspaceRoot}
            onOpenWorkspaceFile={openWorkspaceFile}
          >
            <WorkspaceSwitchContext.Provider value={setWorkspaceRoot}>
              {children}
            </WorkspaceSwitchContext.Provider>
          </AssistantFileLinkResolverProvider>
        </QueryClientProvider>
      );
    }

    const { result } = renderHook(
      () => ({
        link: useFileLink(SOURCE),
        setWorkspaceRoot: React.useContext(WorkspaceSwitchContext),
      }),
      { wrapper: Wrapper },
    );

    act(() => {
      result.current.link.onPress();
    });
    act(() => {
      result.current.setWorkspaceRoot("/Users/test/other");
    });
    await resolveLookupAndDeliver(
      deferred,
      resolvedSuggestions([{ path: "docs/dumm.md", kind: "file" }]),
    );

    expect(getDirectorySuggestions).toHaveBeenCalledTimes(1);
    expect(openedFiles).toEqual([]);
  });
});

const WorkspaceSwitchContext = React.createContext<(workspaceRoot: string) => void>(() => {});
