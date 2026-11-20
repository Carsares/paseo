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
  quote: string;
  messageRowId: string | null;
}

type PendingMenuAction =
  | { kind: "quote"; quote: string }
  | { kind: "spawn"; quote: string; messageRowId: string | null };

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
      if (messageRowId === null) {
        onSpawnSubagentFromSelection?.(quote);
      } else {
        onSpawnSubagentFromSelection?.(quote, { messageRowId });
      }
    },
    [onSpawnSubagentFromSelection],
  );

  useEffect(() => {
    if (!menuOpen) setMenuSelection(null);
  }, [menuOpen]);

  useLayoutEffect(() => {
    if (menuOpen || !pendingMenuAction.current) return;
    const action = pendingMenuAction.current;
    pendingMenuAction.current = null;
    // Let the menu restore focus during unmount before the composer or new tab takes it.
    if (action.kind === "quote") {
      onQuote?.({ quote: action.quote });
    } else {
      spawnSubagent(action.quote, action.messageRowId);
    }
  }, [menuOpen, onQuote, spawnSubagent]);

  useEffect(() => {
    let pointerDown = false;
    let frame = 0;

    const readSelection = () => {
      frame = 0;
      if (menuOpenRef.current) return;
      const passage = readSelectionPassage(streamRef.current, window.getSelection());
      update(passage ? { phase: "offered", ...passage } : IDLE);
    };
    const scheduleRead = () => {
      if (!frame) frame = window.requestAnimationFrame(readSelection);
    };
    const handleSelectionChange = () => {
      // A drag settles on pointerup; until then the button would chase the pointer.
      if (!pointerDown && !menuOpenRef.current) scheduleRead();
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (menuOpenRef.current) return;
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

  useEffect(() => {
    const stream = streamRef.current;
    if (!stream || (!onQuote && !onSpawnSubagentFromSelection)) return;
    const handleContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
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
  }, [onQuote, onSpawnSubagentFromSelection, setAnchorRect, setMenuOpen, streamRef, update]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    const handleOutsidePointerDown = (event: PointerEvent) => {
      if (eventTargetElement(event.target)?.closest(`[data-testid="${SELECTION_MENU_ID}"]`)) return;
      close();
    };
    document.addEventListener("pointerdown", handleOutsidePointerDown, true);
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", handleOutsidePointerDown, true);
      document.removeEventListener("scroll", close, true);
    };
  }, [menuOpen, setMenuOpen]);

  const dismiss = useCallback(() => update(IDLE), [update]);
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
      <ContextMenuContent offset={0} testID={SELECTION_MENU_ID}>
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
        {onSpawnSubagentFromSelection || onQuote ? <ContextMenuSeparator /> : null}
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
  if (state.phase === "offered" && (onQuote || onSpawnSubagentFromSelection)) {
    return (
      <QuoteButton
        passage={state}
        streamRef={streamRef}
        floatingRef={floatingRef}
        onPress={onQuote ? quoteFromPill : undefined}
        spawnLabel={spawnLabel}
        onSpawnSubagent={onSpawnSubagentFromSelection ? spawnSubagentFromPill : undefined}
        onDismiss={dismiss}
      />
    );
  }
  return null;
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
  return quote ? { range: range.cloneRange(), endpoints, quote, messageRowId } : null;
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
  onPress,
  spawnLabel,
  onSpawnSubagent,
  onDismiss,
}: {
  passage: SelectionPassage;
  streamRef: AssistantSelectionQuoteProps["streamRef"];
  floatingRef: RefObject<HTMLElement | null>;
  onPress?: () => void;
  spawnLabel: string;
  onSpawnSubagent?: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const layer = useOverlayLayer("floating");
  const anchor = useRangeEndRect(passage, streamRef);
  const handleKeyDown = useCallback(
    (event: KeyboardInputEvent) => {
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
    [onDismiss, onPress],
  );
  const setOverlayScope = useOverlayRegistration({
    keys: ["Escape", "Enter"],
    active: anchor !== null,
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
    </AnchoredSurface>
  );
}

function AnchoredSurface({
  anchor,
  alignment,
  layer,
  entering,
  style,
  surfaceRef,
  testID,
  children,
}: {
  anchor: Rect | null;
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
  }, [alignment, anchor, size]);
  const surfaceStyle = useMemo(() => [styles.surface, style], [style]);
  const overlayStyle = useMemo(() => [styles.portalOverlay, { zIndex: layer }], [layer]);

  if (!anchor) return null;
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
): Rect | null {
  const [rect, setRect] = useState<Rect | null>(() => rangeEndRect(passage, streamRef.current));
  useEffect(() => {
    const stream = streamRef.current;
    if (!isWeb || !stream) return;
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
  }, [passage, streamRef]);
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
