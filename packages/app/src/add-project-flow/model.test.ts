import { createInstance } from "i18next";
import { en } from "@/i18n/resources/en";
import { zhCN } from "@/i18n/resources/zh-CN";
import { describe, expect, it } from "vitest";
import {
  backAddProjectPage,
  chooseAddProjectHost,
  currentAddProjectPage,
  moveAddProjectActiveIndex,
  moveAddProjectSelection,
  openAddProjectFlow,
  openDirectorySearchPage,
  openGithubLocationPage,
  openNewDirectoryNamePage,
  openNewDirectoryParentPage,
  setAddProjectActiveIndex,
  setAddProjectPageInput,
  setNewDirectoryName,
  type AddProjectHost,
} from "./model";
import {
  addProjectMethodEmptyText,
  buildAddProjectMethods,
  buildCloneLocationOptions,
  buildManualGithubRepositoryChoices,
} from "./options";

const HOST: AddProjectHost = {
  serverId: "host-1",
  label: "Local",
  canAddProject: true,
  canBrowse: true,
  canCloneGithubRepositories: true,
  canSearchGithubRepositories: true,
  canCreateDirectory: true,
};

describe("Add Project navigation", () => {
  it("skips a single connected host without adding it to history", () => {
    const state = openAddProjectFlow({ hosts: [HOST] });

    expect(currentAddProjectPage(state)).toEqual({
      kind: "method",
      hostId: "host-1",
      activeIndex: 0,
      error: null,
      isSubmitting: false,
    });
    expect(backAddProjectPage(state)).toBeNull();
  });

  it("restores page input and selection after Back", () => {
    const secondHost = { ...HOST, serverId: "host-2", label: "Remote" };
    let state = openAddProjectFlow({ hosts: [HOST, secondHost] });
    state = setAddProjectPageInput(state, "rem");
    state = setAddProjectActiveIndex(state, 1);
    state = chooseAddProjectHost(state, secondHost.serverId);
    state = openDirectorySearchPage(state, secondHost.serverId);

    state = backAddProjectPage(state) ?? state;
    state = backAddProjectPage(state) ?? state;

    expect(currentAddProjectPage(state)).toEqual({
      kind: "host",
      query: "rem",
      activeIndex: 1,
      error: null,
    });
  });

  it("wraps keyboard selection in both directions", () => {
    expect(moveAddProjectActiveIndex(2, 3, "next")).toBe(0);
    expect(moveAddProjectActiveIndex(0, 3, "previous")).toBe(2);
    expect(moveAddProjectSelection(0, [true, false, true], "next")).toBe(2);
  });

  it("restores a directory name after returning to and reselecting its parent", () => {
    let state = openAddProjectFlow({ hosts: [HOST] });
    state = openNewDirectoryParentPage(state, HOST.serverId);
    state = openNewDirectoryNamePage(state, HOST.serverId, "~/dev");
    state = setNewDirectoryName(state, "command-center");
    state = backAddProjectPage(state) ?? state;
    state = openNewDirectoryNamePage(state, HOST.serverId, "~/dev");

    expect(currentAddProjectPage(state)).toMatchObject({
      kind: "new-directory-name",
      parentPath: "~/dev",
      name: "command-center",
    });
  });

  it("restores the GitHub destination query and active parent when reopening a repository", () => {
    const repository = {
      id: "repo-1",
      nameWithOwner: "getpaseo/paseo",
      cloneUrl: "git@github.com:getpaseo/paseo.git",
      description: null,
      visibility: "public",
      updatedAt: null,
    };
    let state = openAddProjectFlow({ hosts: [HOST] });
    state = openGithubLocationPage(state, HOST.serverId, repository);
    state = setAddProjectPageInput(state, "~/dev");
    state = setAddProjectActiveIndex(state, 2);
    state = backAddProjectPage(state) ?? state;
    state = openGithubLocationPage(state, HOST.serverId, repository);

    expect(currentAddProjectPage(state)).toMatchObject({
      kind: "github-location",
      query: "~/dev",
      activeIndex: 2,
    });
  });
});

describe("Add Project options", () => {
  const translations = createInstance();
  void translations.init({
    lng: "en",
    resources: { en: { translation: en }, "zh-CN": { translation: zhCN } },
    initAsync: false,
    interpolation: { escapeValue: false },
  });
  const t = translations.getFixedT("en");

  it("localizes method labels and descriptions without changing host and path values", () => {
    const chinese = translations.getFixedT("zh-CN");
    expect(buildAddProjectMethods(HOST, chinese)).toMatchObject([
      { label: "搜索目录", description: "在 Local 上查找目录" },
      { label: "浏览", description: "在 Finder 中选择或创建目录" },
      { label: "从 GitHub 克隆" },
      { label: "新建目录", description: "在 Local 上创建空目录" },
    ]);
    expect(
      buildCloneLocationOptions(
        { parents: ["~/dev"], repositoryName: "paseo", existingPaths: [] },
        chinese,
      ),
    ).toMatchObject([{ displayPath: "~/dev/paseo", secondaryText: "父目录：~/dev" }]);
  });

  it("hides every mutating method when the host lacks stable project identity", () => {
    const outdatedHost = { ...HOST, canAddProject: false };

    expect(buildAddProjectMethods(outdatedHost, t)).toEqual([]);
    expect(addProjectMethodEmptyText(outdatedHost, t)).toBe("Update the host to use Add Project.");
  });

  it("keeps host-upgrade methods discoverable while hiding local-only Browse", () => {
    expect(
      buildAddProjectMethods(
        {
          ...HOST,
          canBrowse: false,
          canCloneGithubRepositories: false,
          canSearchGithubRepositories: false,
          canCreateDirectory: false,
        },
        t,
      ),
    ).toEqual([
      {
        id: "directory-search",
        label: "Search for directory",
        description: "Find a directory on Local",
      },
      {
        id: "github",
        label: "Clone from GitHub",
        description: "Update this host to clone GitHub repositories",
        disabled: true,
      },
      {
        id: "new-directory",
        label: "New directory",
        description: "Update this host to create directories",
        disabled: true,
      },
    ]);
  });

  it("offers manual URL and protocol-specific owner/repo clone choices", () => {
    expect(buildManualGithubRepositoryChoices("git@github.com:getpaseo/paseo.git", t)).toEqual([
      expect.objectContaining({
        id: "manual:git@github.com:getpaseo/paseo.git",
        nameWithOwner: "getpaseo/paseo",
        cloneUrl: "git@github.com:getpaseo/paseo.git",
      }),
    ]);
    expect(buildManualGithubRepositoryChoices("getpaseo/paseo", t)).toEqual([
      expect.objectContaining({ cloneProtocol: "https", cloneUrl: "getpaseo/paseo" }),
      expect.objectContaining({ cloneProtocol: "ssh", cloneUrl: "getpaseo/paseo" }),
    ]);
    expect(buildManualGithubRepositoryChoices("paseo", t)).toEqual([]);
  });

  it("shows final clone paths while retaining parent paths as values", () => {
    expect(
      buildCloneLocationOptions(
        {
          parents: ["~/dev", "~/workspace"],
          repositoryName: "paseo",
          existingPaths: ["~/workspace/paseo"],
        },
        t,
      ),
    ).toEqual([
      {
        id: "~/dev",
        path: "~/dev",
        displayPath: "~/dev/paseo",
        secondaryText: "Parent directory: ~/dev",
        disabled: false,
      },
      {
        id: "~/workspace",
        path: "~/workspace",
        displayPath: "~/workspace/paseo",
        secondaryText: "Already exists",
        disabled: true,
      },
    ]);
  });

  it("shows equivalent absolute-home and tilde destinations only once", () => {
    expect(
      buildCloneLocationOptions(
        {
          parents: ["/Users/moboudra/dev", "~/dev"],
          repositoryName: "dotfiles",
          existingPaths: [],
        },
        t,
      ),
    ).toEqual([
      {
        id: "/Users/moboudra/dev",
        path: "/Users/moboudra/dev",
        displayPath: "/Users/moboudra/dev/dotfiles",
        secondaryText: "Parent directory: /Users/moboudra/dev",
        disabled: false,
      },
    ]);
  });
});
