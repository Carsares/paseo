import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Dimensions,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { createPortal } from "react-dom";
import type { PluginTimelineSelection } from "@getpaseo/plugin/client";
import { FadeIn } from "react-native-reanimated";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Copy, GitBranch, TextQuote } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { computePosition, type Alignment, type Rect, type Size } from "@/components/ui/anchor";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  useContextMenu,
} from "@/components/ui/context-menu";
import { FloatingSurface, type FloatingSurfaceProps } from "@/components/ui/floating";
import { isWeb } from "@/constants/platform";
import { resolveKeyboardFocusScope } from "@/keyboard/focus-scope";
import { getOverlayRoot, OverlayLayerProvider, useOverlayLayer } from "@/lib/overlay-root";
import { useOverlayRegistration, type KeyboardInputEvent } from "@/keyboard";
import { PluginSelectionButtons, usePluginSelectionMenu } from "@/plugins/buttons/view";
import type { RegisteredPluginButton } from "@/plugins/buttons/model";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import type { MarkdownClipboardContent } from "@/utils/rich-clipboard";
import {
  createAssistantSelectionClipboardContent,
  createAssistantSelectionMarkdown,
} from "./content.web";
import type { ComposerQuote } from "./composer-quote";
import type { SelectionSubagentSpawnContext, SelectionSubagentSpawnMode } from "./surface";

type QuoteState = { phase: "idle" } | ({ phase: "offered" } & SelectionPassage);
interface SelectionPassage {
  range: Range;
  endpoints: readonly [Node, Node];
  text: string;
  quote: string;
  messageRowId: string | null;
}

type PendingMenuAction =
  | { kind: "quote"; quote: string }
  | { kind: "spawn"; quote: string; messageRowId: string | null }
  | { kind: "plugin"; run: () => void };

const IDLE: QuoteState = { phase: "idle" };
const ANCHOR_OFFSET = 4;
const FADE_IN = FadeIn.duration(80);
const SELECTION_MENU_ID = "assistant-selection-context-menu";
const MenuBranchIcon = withUnistyles(GitBranch);
const MenuQuoteIcon = withUnistyles(TextQuote);
const MenuCopyIcon = withUnistyles(Copy);
const menuIconColor = (theme: Theme) => ({ color: theme.colors.foreground });
const branchIcon = <MenuBranchIcon size={ICON_SIZE.sm} uniProps={menuIconColor} />;
const quoteIcon = <MenuQuoteIcon size={ICON_SIZE.sm} uniProps={menuIconColor} />;
const copyIcon = <MenuCopyIcon size={ICON_SIZE.sm} uniProps={menuIconColor} />;

interface AssistantSelectionQuoteProps {
  streamRef: RefObject<HTMLElement | null>;
  workspaceId?: string;
  agentId?: string;
  selectionButtons?: readonly RegisteredPluginButton[];
  canSubmitSelection?: (agentId: string, workspaceId: string) => boolean;
  onQuote?: (quote: ComposerQuote) => void;
  subagentSpawnMode?: SelectionSubagentSpawnMode;
  onSpawnSubagentFromSelection?: (
    selectedMarkdown: string,
    context?: SelectionSubagentSpawnContext,
  ) => void;
}

export function AssistantSelectionQuote(props: AssistantSelectionQuoteProps) {
  if (!isWeb) return null;
  return (
    <ContextMenu compactMode="popover">
      <SelectionActions {...props} />
    </ContextMenu>
  );
}

/**
 * Capture the passage when the selection settles, before streaming updates or menu
 * interaction can change the selection.
 */
function SelectionActions({
  streamRef,
  workspaceId,
  agentId,
  selectionButtons = NO_SELECTION_BUTTONS,
  canSubmitSelection,
  onQuote,
  subagentSpawnMode = "child",
  onSpawnSubagentFromSelection,
}: AssistantSelectionQuoteProps) {
  const { t } = useTranslation();
  const spawnLabel =
    subagentSpawnMode === "sibling"
      ? t("agentStream.quote.newSibling")
      : t("agentStream.quote.newSubagent");
  const [state, setState] = useState<QuoteState>(IDLE);
  const [menuSelection, setMenuSelection] = useState<
    (SelectionPassage & { clipboard: MarkdownClipboardContent }) | null
  >(null);
  const stateRef = useRef(state);
  const floatingRef = useRef<HTMLElement | null>(null);
  const floatingMenu = useRef<{ restoreFocus: HTMLElement | null } | null>(null);
  const recordFloatingMenu = useCallback((restoreFocus: HTMLElement | null) => {
    floatingMenu.current = { restoreFocus };
  }, []);
  useLayoutEffect(
    () => () => {
      if (floatingMenu.current) window.getSelection()?.removeAllRanges();
      floatingMenu.current = null;
    },
    [],
  );
  const { open: menuOpen, setOpen: setMenuOpen, setAnchorRect } = useContextMenu();
  const pendingMenuAction = useRef<PendingMenuAction | null>(null);
  const menuOpenRef = useRef(menuOpen);
  menuOpenRef.current = menuOpen;
  const update = useCallback((next: QuoteState) => {
    stateRef.current = next;
    setState(next);
  }, []);
  const spawnSubagent = useCallback(
    (quote: string, messageRowId: string | null) => {
      if (messageRowId === null) onSpawnSubagentFromSelection?.(quote);
      else onSpawnSubagentFromSelection?.(quote, { messageRowId });
    },
    [onSpawnSubagentFromSelection],
  );

  useEffect(() => {
    if (!menuOpen) setMenuSelection(null);
  }, [menuOpen]);

  useLayoutEffect(() => {
    if (menuOpen || state.phase !== "idle") return;
    const restoreFocus = floatingMenu.current?.restoreFocus;
    floatingMenu.current = null;
    // The menu's usual restore target is its trigger, which leaves with the selection toolbar.
    if (restoreFocus?.isConnected && document.activeElement === document.body) {
      restoreFocus.focus({ preventScroll: true });
    }
    const action = pendingMenuAction.current;
    pendingMenuAction.current = null;
    if (!action) return;
    // Let the menu restore focus during unmount before the action can move it again.
    if (action.kind === "quote") {
      onQuote?.({ quote: action.quote });
    } else if (action.kind === "spawn") {
      spawnSubagent(action.quote, action.messageRowId);
    } else {
      action.run();
    }
  }, [menuOpen, onQuote, spawnSubagent, state.phase]);

  useEffect(() => {
    let pointerDown = false;
    let frame = 0;

    const readSelection = () => {
      frame = 0;
      if (menuOpenRef.current || floatingMenu.current) return;
      const passage = readSelectionPassage(streamRef.current, window.getSelection());
      update(passage ? { phase: "offered", ...passage } : IDLE);
    };
    const scheduleRead = () => {
      if (!frame) frame = window.requestAnimationFrame(readSelection);
    };
    const handleSelectionChange = () => {
      // A drag settles on pointerup; until then the button would chase the pointer.
      if (!pointerDown && !menuOpenRef.current && !floatingMenu.current) scheduleRead();
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (menuOpenRef.current || floatingMenu.current) return;
      if (floatingRef.current?.contains(event.target as Node)) return;
      update(IDLE);
      if (event.button === 2) return;
      pointerDown = true;
    };
    const handlePointerUp = () => {
      if (!pointerDown) return;
      pointerDown = false;
      scheduleRead();
    };

    document.addEventListener("selectionchange", handleSelectionChange);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("pointerup", handlePointerUp, true);
    document.addEventListener("pointercancel", handlePointerUp, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", handleSelectionChange);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("pointerup", handlePointerUp, true);
      document.removeEventListener("pointercancel", handlePointerUp, true);
    };
  }, [streamRef, update]);

  const hasSelectionActions = Boolean(
    onQuote || onSpawnSubagentFromSelection || selectionButtons.length,
  );
  useEffect(() => {
    const stream = streamRef.current;
    if (!stream || !hasSelectionActions) return;
    const handleContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented || floatingMenu.current) return;
      if (isEditableContextTarget(event.target)) return;
      const selection = window.getSelection();
      const passage = readSelectionPassage(stream, selection);
      if (!passage) return;
      if (event.target instanceof Node && !passage.range.intersectsNode(event.target)) return;
      const clipboard = createAssistantSelectionClipboardContent(selection);
      if (!clipboard) return;

      event.preventDefault();
      event.stopPropagation();
      update(IDLE);
      setMenuSelection({ ...passage, clipboard });
      setAnchorRect({ x: event.clientX, y: event.clientY, width: 0, height: 0 });
      setMenuOpen(true);
    };
    stream.addEventListener("contextmenu", handleContextMenu);
    return () => stream.removeEventListener("contextmenu", handleContextMenu);
  }, [hasSelectionActions, setAnchorRect, setMenuOpen, streamRef, update]);

  useEffect(() => {
    if (!menuOpen) return;
    const handleOutsideInteraction = (event: Event) => {
      if (
        eventTargetElement(event.target)?.closest(
          `[data-testid="${SELECTION_MENU_ID}"], [data-testid^="${SELECTION_MENU_ID}-"]`,
        )
      )
        return;
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", handleOutsideInteraction, true);
    document.addEventListener("scroll", handleOutsideInteraction, true);
    return () => {
      document.removeEventListener("pointerdown", handleOutsideInteraction, true);
      document.removeEventListener("scroll", handleOutsideInteraction, true);
    };
  }, [menuOpen, setMenuOpen]);

  const dismiss = useCallback(() => update(IDLE), [update]);
  const dismissPluginSelection = useCallback(() => {
    dismiss();
    window.getSelection()?.removeAllRanges();
  }, [dismiss]);
  const runPluginSelectionAction = useCallback(
    (run: () => void) => {
      pendingMenuAction.current = { kind: "plugin", run };
      dismissPluginSelection();
    },
    [dismissPluginSelection],
  );
  const contextSelection = useMemo(
    () => pluginSelection(menuSelection, workspaceId, agentId),
    [menuSelection, workspaceId, agentId],
  );
  const contextPluginMenu = usePluginSelectionMenu(
    selectionButtons,
    contextSelection,
    runPluginSelectionAction,
    canSubmitSelection,
  );
  const spawnSubagentFromMenu = useCallback(() => {
    if (!onSpawnSubagentFromSelection || !menuSelection) return;
    pendingMenuAction.current = {
      kind: "spawn",
      quote: menuSelection.quote,
      messageRowId: menuSelection.messageRowId,
    };
    setMenuOpen(false);
    dismiss();
    window.getSelection()?.removeAllRanges();
  }, [dismiss, menuSelection, onSpawnSubagentFromSelection, setMenuOpen]);
  const quoteFromMenu = useCallback(() => {
    if (!onQuote || !menuSelection) return;
    pendingMenuAction.current = { kind: "quote", quote: menuSelection.quote };
    setMenuOpen(false);
    dismiss();
    window.getSelection()?.removeAllRanges();
  }, [dismiss, menuSelection, onQuote, setMenuOpen]);
  const copyFromMenu = useCallback(() => {
    if (!menuSelection) return;
    dismiss();
    void writeSelectionClipboard(menuSelection.clipboard);
  }, [dismiss, menuSelection]);
  const spawnSubagentFromPill = useCallback(() => {
    const current = stateRef.current;
    if (!onSpawnSubagentFromSelection || current.phase !== "offered") return;
    window.getSelection()?.removeAllRanges();
    dismiss();
    spawnSubagent(current.quote, current.messageRowId);
  }, [dismiss, onSpawnSubagentFromSelection, spawnSubagent]);
  const quoteFromPill = useCallback(() => {
    const current = stateRef.current;
    if (!onQuote || current.phase !== "offered") return;
    window.getSelection()?.removeAllRanges();
    dismiss();
    onQuote({ quote: current.quote });
  }, [dismiss, onQuote]);

  if (menuOpen && menuSelection) {
    return (
      <ContextMenuContent offset={0} testID={SELECTION_MENU_ID} pages={contextPluginMenu.pages}>
        {onSpawnSubagentFromSelection ? (
          <ContextMenuItem
            leading={branchIcon}
            testID={`${SELECTION_MENU_ID}-subagent`}
            onSelect={spawnSubagentFromMenu}
          >
            {spawnLabel}
          </ContextMenuItem>
        ) : null}
        {onQuote ? (
          <ContextMenuItem
            leading={quoteIcon}
            testID={`${SELECTION_MENU_ID}-quote`}
            onSelect={quoteFromMenu}
          >
            {t("agentStream.quote.quoteInChat")}
          </ContextMenuItem>
        ) : null}
        {contextPluginMenu.rows}
        {onSpawnSubagentFromSelection || onQuote || contextPluginMenu.rows.length ? (
          <ContextMenuSeparator />
        ) : null}
        <ContextMenuItem
          leading={copyIcon}
          testID={`${SELECTION_MENU_ID}-copy`}
          onSelect={copyFromMenu}
        >
          {t("common.actions.copy")}
        </ContextMenuItem>
      </ContextMenuContent>
    );
  }
  if (state.phase === "offered" && hasSelectionActions) {
    return (
      <QuoteButton
        passage={state}
        streamRef={streamRef}
        floatingRef={floatingRef}
        workspaceId={workspaceId}
        agentId={agentId}
        selectionButtons={selectionButtons}
        canSubmitSelection={canSubmitSelection}
        onPluginMenuOpen={recordFloatingMenu}
        onPluginMenuClose={dismissPluginSelection}
        onPluginAction={runPluginSelectionAction}
        onPress={onQuote ? quoteFromPill : undefined}
        spawnLabel={spawnLabel}
        onSpawnSubagent={onSpawnSubagentFromSelection ? spawnSubagentFromPill : undefined}
        onDismiss={dismiss}
      />
    );
  }
  return null;
}

const NO_SELECTION_BUTTONS: readonly RegisteredPluginButton[] = [];

function pluginSelection(
  passage: SelectionPassage | null,
  workspaceId?: string,
  agentId?: string,
): PluginTimelineSelection | null {
  if (!passage || !workspaceId || !agentId) return null;
  return Object.freeze({
    text: passage.text,
    markdown: passage.quote,
    messageId: passage.messageRowId,
    workspaceId,
    agentId,
  });
}

function readSelectionPassage(
  stream: HTMLElement | null,
  selection: Selection | null,
): SelectionPassage | null {
  if (!stream || !selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!stream.contains(range.commonAncestorContainer)) return null;
  const quote = createAssistantSelectionMarkdown(selection);
  // A live Range can retarget to a connected parent when virtualization removes its text.
  const endpoints = [range.startContainer, range.endContainer] as const;
  const messageRowId =
    eventTargetElement(range.startContainer)
      ?.closest<HTMLElement>("[data-message-id]")
      ?.getAttribute("data-message-id")
      ?.trim() || null;
  return quote
    ? { range: range.cloneRange(), endpoints, text: selection.toString(), quote, messageRowId }
    : null;
}

function eventTargetElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

function isEditableContextTarget(target: EventTarget | null): boolean {
  const element = eventTargetElement(target);
  if (!element) return false;
  if (element instanceof HTMLElement && element.isContentEditable) return true;
  return Boolean(
    element.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'),
  );
}

async function writeSelectionClipboard(clipboard: MarkdownClipboardContent): Promise<void> {
  if (
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.write === "function" &&
    typeof ClipboardItem !== "undefined" &&
    (typeof ClipboardItem.supports !== "function" || ClipboardItem.supports("text/html"))
  ) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([clipboard.plainText], { type: "text/plain" }),
          "text/html": new Blob([clipboard.html], { type: "text/html" }),
        }),
      ]);
      return;
    } catch {
      // Fall through to plain-text clipboard write below.
    }
  }
  if (typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function") {
    try {
      await navigator.clipboard.writeText(clipboard.plainText);
      return;
    } catch {
      // Fall through to expo-clipboard fallback.
    }
  }
  try {
    await copyToClipboard(clipboard.plainText);
  } catch {
    // Ignore clipboard write denial.
  }
}

function QuoteButton({
  passage,
  streamRef,
  floatingRef,
  workspaceId,
  agentId,
  selectionButtons,
  canSubmitSelection,
  onPluginMenuOpen,
  onPluginMenuClose,
  onPluginAction,
  onPress,
  spawnLabel,
  onSpawnSubagent,
  onDismiss,
}: {
  passage: SelectionPassage;
  streamRef: AssistantSelectionQuoteProps["streamRef"];
  floatingRef: RefObject<HTMLElement | null>;
  workspaceId?: string;
  agentId?: string;
  selectionButtons: readonly RegisteredPluginButton[];
  canSubmitSelection?: (agentId: string, workspaceId: string) => boolean;
  onPluginMenuOpen(restoreFocus: HTMLElement | null): void;
  onPluginMenuClose(): void;
  onPluginAction(run: () => void): void;
  onPress?: () => void;
  spawnLabel: string;
  onSpawnSubagent?: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const layer = useOverlayLayer("floating");
  const [openMenu, setOpenMenu] = useState<{
    key: number;
    position: Pick<Rect, "x" | "y">;
    selection: PluginTimelineSelection;
  } | null>(null);
  const anchor = useRangeEndRect(passage, streamRef, openMenu !== null);
  const selection = useMemo(
    () => pluginSelection(passage, workspaceId, agentId),
    [passage, workspaceId, agentId],
  );
  const closePluginMenu = useCallback(() => setOpenMenu(null), []);
  const menuWasOpen = useRef(false);
  useLayoutEffect(() => {
    if (menuWasOpen.current && !openMenu) onPluginMenuClose();
    menuWasOpen.current = openMenu !== null;
  }, [onPluginMenuClose, openMenu]);
  const handlePluginMenuOpenChange = useCallback(
    (key: number, open: boolean) => {
      if (!open) {
        if (openMenu?.key === key) closePluginMenu();
        return;
      }
      const surface = floatingRef.current;
      if (!anchor || !selection || !surface) return;
      const { x, y } = surface.getBoundingClientRect();
      // Lock synchronously before the menu can move focus or replace the browser selection.
      const active = document.activeElement;
      onPluginMenuOpen(active instanceof HTMLElement && !surface.contains(active) ? active : null);
      setOpenMenu({ key, position: { x, y }, selection });
    },
    [anchor, closePluginMenu, floatingRef, onPluginMenuOpen, openMenu, selection],
  );
  useEffect(() => {
    if (!openMenu) return;
    const entry = selectionButtons.find((button) => button.key === openMenu.key);
    if (!entry || entry.button.disabled || entry.button.behavior.kind === "action")
      closePluginMenu();
  }, [closePluginMenu, openMenu, selectionButtons]);
  const handleKeyDown = useCallback(
    (event: KeyboardInputEvent) => {
      if (openMenu) return false;
      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
        return true;
      }
      // Like Escape, this comes before the app's shortcuts, dictation's Enter included.
      if (onPress && isBareEnter(event) && !focusReadsEnter(document.activeElement)) {
        event.preventDefault();
        if (!event.repeat) {
          swallowEnterRepeatsUntilReleased();
          onPress();
        }
        return true;
      }
      return false;
    },
    [onDismiss, onPress, openMenu],
  );
  const setOverlayScope = useOverlayRegistration({
    keys: ["Escape", "Enter"],
    active: anchor !== null && !openMenu,
    layer,
    onKeyDown: handleKeyDown,
    manageFocus: false,
    passive: true,
  });
  const setSurface = useCallback(
    (node: View | null) => {
      const element = node instanceof HTMLElement ? node : null;
      // Pressing must not move focus or collapse the selection it quotes.
      floatingRef.current?.removeEventListener("mousedown", preventDefault);
      element?.addEventListener("mousedown", preventDefault);
      floatingRef.current = element;
      setOverlayScope(element);
    },
    [floatingRef, setOverlayScope],
  );

  return (
    <AnchoredSurface
      anchor={anchor}
      frozenPosition={openMenu?.position}
      alignment="end"
      layer={layer}
      entering={FADE_IN}
      style={styles.actionSurface}
      surfaceRef={setSurface}
      testID="assistant-selection-quote"
    >
      {onPress ? (
        <Button variant="ghost" size="sm" leftIcon={TextQuote} onPress={onPress}>
          {t("agentStream.quote.action")}
        </Button>
      ) : null}
      {onSpawnSubagent ? (
        <Button
          variant="ghost"
          size="sm"
          leftIcon={GitBranch}
          onPress={onSpawnSubagent}
          testID="assistant-selection-spawn-subagent"
        >
          {spawnLabel}
        </Button>
      ) : null}
      {selection && selectionButtons.length > 0 ? (
        <PluginSelectionButtons
          entries={selectionButtons}
          selection={openMenu?.selection ?? selection}
          openKey={openMenu?.key ?? null}
          onOpenChange={handlePluginMenuOpenChange}
          onAction={onPluginAction}
          canSubmit={canSubmitSelection}
        />
      ) : null}
    </AnchoredSurface>
  );
}

function AnchoredSurface({
  anchor,
  frozenPosition,
  alignment,
  layer,
  entering,
  style,
  surfaceRef,
  testID,
  children,
}: {
  anchor: Rect | null;
  frozenPosition?: Pick<Rect, "x" | "y">;
  alignment: Alignment;
  layer: number;
  entering?: FloatingSurfaceProps["entering"];
  style?: StyleProp<ViewStyle>;
  /** The whole floating surface, padding included, so a press on its rim stays inside. */
  surfaceRef: (node: View | null) => void;
  testID: string;
  children: ReactNode;
}) {
  const [size, setSize] = useState<Size | null>(null);
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize({ width, height });
  }, []);
  const frameStyle = useMemo(() => {
    if (frozenPosition) {
      return { position: "absolute" as const, top: frozenPosition.y, left: frozenPosition.x };
    }
    if (!anchor || !size) return { position: "absolute" as const, top: -9999, left: -9999 };
    const { width, height } = Dimensions.get("window");
    const { x, y } = computePosition({
      triggerRect: anchor,
      contentSize: size,
      displayArea: { x: 0, y: 0, width, height },
      placement: "bottom",
      alignment,
      offset: ANCHOR_OFFSET,
    });
    return { position: "absolute" as const, top: y, left: x };
  }, [alignment, anchor, frozenPosition, size]);
  const surfaceStyle = useMemo(() => [styles.surface, style], [style]);
  const overlayStyle = useMemo(() => [styles.portalOverlay, { zIndex: layer }], [layer]);

  if (!anchor && !frozenPosition) return null;
  return createPortal(
    <OverlayLayerProvider layer={layer}>
      <View pointerEvents="box-none" style={overlayStyle}>
        <FloatingSurface
          ref={surfaceRef}
          entering={entering}
          collapsable={false}
          onLayout={handleLayout}
          testID={testID}
          style={surfaceStyle}
          frameStyle={frameStyle}
        >
          {children}
        </FloatingSurface>
      </View>
    </OverlayLayerProvider>,
    getOverlayRoot(),
  );
}

/**
 * Follow the last visible line through scrolling and transcript layout changes.
 */
function useRangeEndRect(
  passage: SelectionPassage,
  streamRef: AssistantSelectionQuoteProps["streamRef"],
  locked: boolean,
): Rect | null {
  const [rect, setRect] = useState<Rect | null>(() => rangeEndRect(passage, streamRef.current));
  useEffect(() => {
    const stream = streamRef.current;
    if (!isWeb || !stream || locked) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      setRect(rangeEndRect(passage, streamRef.current));
    };
    const scheduleMeasure = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    measure();
    document.addEventListener("scroll", scheduleMeasure, true);
    window.addEventListener("resize", scheduleMeasure);
    const viewport = selectionViewport(stream, passage.endpoints[0]);
    const resize =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
    resize?.observe(viewport);
    if (viewport.firstElementChild) resize?.observe(viewport.firstElementChild);
    const mutations = new MutationObserver(scheduleMeasure);
    mutations.observe(stream, { childList: true, subtree: true, characterData: true });
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("scroll", scheduleMeasure, true);
      window.removeEventListener("resize", scheduleMeasure);
      resize?.disconnect();
      mutations.disconnect();
    };
  }, [locked, passage, streamRef]);
  return rect;
}

function selectionViewport(stream: HTMLElement, start: Node): HTMLElement {
  // The selection wrapper uses display: contents; its descendant owns scrolling.
  return (
    eventTargetElement(start)?.closest<HTMLElement>('[data-testid="agent-chat-scroll"]') ?? stream
  );
}

function rangeEndRect(
  { range, endpoints }: SelectionPassage,
  stream: HTMLElement | null,
): Rect | null {
  if (
    !isWeb ||
    !stream ||
    !range.startContainer.isConnected ||
    !range.endContainer.isConnected ||
    endpoints.some((node) => !node.isConnected || !stream.contains(node))
  ) {
    return null;
  }
  const viewport = selectionViewport(stream, endpoints[0]);
  const bounds = viewport.getClientRects()[0] ?? { top: 0, bottom: window.innerHeight };
  const last = Array.from(range.getClientRects()).findLast(
    (box) => box.width > 0 && box.top < bounds.bottom && box.top + box.height > bounds.top,
  );
  return last ? { x: last.left, y: last.top, width: last.width, height: last.height } : null;
}

function isBareEnter(event: KeyboardInputEvent): boolean {
  return (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !isImeComposingKeyboardEvent(event)
  );
}

/**
 * Whether the focused element answers Enter itself: a text field, the composer or the
 * terminal, or a control Enter presses. Quote only when Enter would otherwise do nothing.
 */
function focusReadsEnter(target: EventTarget | null): boolean {
  if (resolveKeyboardFocusScope({ target, commandCenterOpen: false }) !== "other") return true;
  return target instanceof HTMLElement && target !== document.body && target.tabIndex >= 0;
}

/**
 * A held Enter can repeat after focus moves to the composer. Swallow those repeats until
 * the key comes up so a single press cannot add the quote and then send the draft.
 */
function swallowEnterRepeatsUntilReleased() {
  const swallowRepeat = (event: KeyboardEvent) => {
    if (event.key !== "Enter") return;
    // A fresh press means the key came up where this listener could not see it.
    if (!event.repeat) {
      release();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const releaseOnKeyUp = (event: KeyboardEvent) => {
    if (event.key === "Enter") release();
  };
  const release = () => {
    window.removeEventListener("keydown", swallowRepeat, true);
    window.removeEventListener("keyup", releaseOnKeyUp, true);
    window.removeEventListener("blur", release);
  };
  // Added while the submitting press is dispatched on window, whose listeners for that press
  // are already fixed, so the press itself never reaches this one.
  window.addEventListener("keydown", swallowRepeat, true);
  window.addEventListener("keyup", releaseOnKeyUp, true);
  window.addEventListener("blur", release);
}

function preventDefault(event: Event) {
  event.preventDefault();
}

const styles = StyleSheet.create((theme) => ({
  actionSurface: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  portalOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  surface: {
    backgroundColor: theme.colors.popover,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[1],
    ...theme.shadow.md,
  },
}));
