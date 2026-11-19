import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Dimensions,
  Text,
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
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
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

type QuoteState = { phase: "idle" } | { phase: "offered" | "noting"; range: Range; quote: string };
interface SelectionPassage {
  range: Range;
  quote: string;
}

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
  onSpawnSubagentFromSelection?: (selectedMarkdown: string) => void;
}

export function AssistantSelectionQuote(props: AssistantSelectionQuoteProps) {
  return (
    <ContextMenu compactMode="popover">
      <SelectionActions {...props} />
    </ContextMenu>
  );
}

/**
 * Quote for a selection inside one agent message: a Quote button at the end of the
 * selection, or Enter while it shows, opens a note box, and Enter puts the quote and the
 * note into the composer.
 *
 * The quote is read when the selection settles, so a message that keeps streaming, or
 * a selection the note box takes over, still quotes what was selected.
 */
function SelectionActions({
  streamRef,
  onQuote,
  onSpawnSubagentFromSelection,
}: AssistantSelectionQuoteProps) {
  const { i18n } = useTranslation();
  const isChinese = i18n.language?.startsWith("zh");
  const spawnLabel = isChinese ? "新建子会话" : "New subagent";
  const [state, setState] = useState<QuoteState>(IDLE);
  const [menuSelection, setMenuSelection] = useState<
    (SelectionPassage & { clipboard: MarkdownClipboardContent }) | null
  >(null);
  const stateRef = useRef(state);
  const floatingRef = useRef<HTMLElement | null>(null);
  const { open: menuOpen, setOpen: setMenuOpen, setAnchorRect } = useContextMenu();
  const menuOpenRef = useRef(menuOpen);
  menuOpenRef.current = menuOpen;
  const update = useCallback((next: QuoteState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    if (!menuOpen) setMenuSelection(null);
  }, [menuOpen]);

  useEffect(() => {
    let pointerDown = false;
    let frame = 0;

    const readSelection = () => {
      frame = 0;
      if (stateRef.current.phase === "noting" || menuOpenRef.current) return;
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
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", handleSelectionChange);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("pointerup", handlePointerUp, true);
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
    if (!menuSelection) return;
    dismiss();
    onSpawnSubagentFromSelection?.(menuSelection.quote);
  }, [dismiss, menuSelection, onSpawnSubagentFromSelection]);
  const quoteFromMenu = useCallback(() => {
    if (menuSelection) {
      update({ phase: "noting", range: menuSelection.range, quote: menuSelection.quote });
    }
  }, [menuSelection, update]);
  const copyFromMenu = useCallback(() => {
    if (!menuSelection) return;
    dismiss();
    void writeSelectionClipboard(menuSelection.clipboard);
  }, [dismiss, menuSelection]);
  const spawnSubagentFromPill = useCallback(() => {
    const current = stateRef.current;
    if (current.phase !== "offered") return;
    dismiss();
    onSpawnSubagentFromSelection?.(current.quote);
  }, [dismiss, onSpawnSubagentFromSelection]);
  const openNote = useCallback(() => {
    const current = stateRef.current;
    if (current.phase === "offered") update({ ...current, phase: "noting" });
  }, [update]);
  const submitNote = useCallback(
    (note: string) => {
      const current = stateRef.current;
      if (current.phase !== "noting") return;
      onQuote?.({ quote: current.quote, note });
      update(IDLE);
    },
    [onQuote, update],
  );
  const cancelNote = useCallback(() => {
    const current = stateRef.current;
    if (current.phase !== "noting") return;
    update(IDLE);
    // Escape hands the passage back as it was, so it can be copied or quoted again.
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(current.range);
  }, [update]);

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
            {isChinese ? "引用到当前会话" : "Quote in chat"}
          </ContextMenuItem>
        ) : null}
        {onSpawnSubagentFromSelection || onQuote ? <ContextMenuSeparator /> : null}
        <ContextMenuItem
          leading={copyIcon}
          testID={`${SELECTION_MENU_ID}-copy`}
          onSelect={copyFromMenu}
        >
          {isChinese ? "复制" : "Copy"}
        </ContextMenuItem>
      </ContextMenuContent>
    );
  }
  if (state.phase === "offered") {
    return (
      <QuoteButton
        range={state.range}
        floatingRef={floatingRef}
        onPress={onQuote ? openNote : undefined}
        spawnLabel={spawnLabel}
        onSpawnSubagent={onSpawnSubagentFromSelection ? spawnSubagentFromPill : undefined}
        onDismiss={dismiss}
      />
    );
  }
  if (state.phase === "noting") {
    return (
      <QuoteNoteBox
        range={state.range}
        floatingRef={floatingRef}
        onSubmit={submitNote}
        onCancel={cancelNote}
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
  return quote ? { range: range.cloneRange(), quote } : null;
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
  range,
  floatingRef,
  onPress,
  spawnLabel,
  onSpawnSubagent,
  onDismiss,
}: {
  range: Range;
  floatingRef: RefObject<HTMLElement | null>;
  onPress?: () => void;
  spawnLabel: string;
  onSpawnSubagent?: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const layer = useOverlayLayer("floating");
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
        onPress();
        return true;
      }
      return false;
    },
    [onDismiss, onPress],
  );
  const setOverlayScope = useOverlayRegistration({
    keys: ["Escape", "Enter"],
    active: true,
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
      range={range}
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
          variant="secondary"
          size="sm"
          onPress={onSpawnSubagent}
          testID="assistant-selection-spawn-subagent"
        >
          {spawnLabel}
        </Button>
      ) : null}
    </AnchoredSurface>
  );
}

function QuoteNoteBox({
  range,
  floatingRef,
  onSubmit,
  onCancel,
}: {
  range: Range;
  floatingRef: RefObject<HTMLElement | null>;
  onSubmit: (note: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const layer = useOverlayLayer("floating");
  const inputRef = useRef<EditingTextInputHandle | null>(null);
  const noteRef = useRef("");
  const handleChangeText = useCallback((text: string) => {
    noteRef.current = text;
  }, []);
  const handleKeyDown = useCallback(
    (event: KeyboardInputEvent) => {
      const input = inputRef.current?.getNativeRef();
      if (event.key === "Escape") {
        event.preventDefault();
        // Let go of focus first, so the passage can be selected again behind the box.
        if (input instanceof HTMLElement) input.blur();
        onCancel();
        return true;
      }
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        document.activeElement === input &&
        !isImeComposingKeyboardEvent(event)
      ) {
        event.preventDefault();
        // A held Enter that opened the box repeats into it; only a fresh press adds the quote.
        if (!event.repeat) {
          // onSubmit moves focus to the composer, whose Enter sends: drop this key's repeats
          // until it comes up.
          swallowEnterRepeatsUntilReleased();
          onSubmit(noteRef.current);
        }
        return true;
      }
      return false;
    },
    [onCancel, onSubmit],
  );
  // The box takes focus itself: the registry would hand focus back to the page when it
  // closes, and Enter moves it to the composer.
  const setOverlayScope = useOverlayRegistration({
    keys: ["Escape", "Enter"],
    active: true,
    layer,
    onKeyDown: handleKeyDown,
    manageFocus: false,
  });
  const setSurface = useCallback(
    (node: View | null) => {
      const element = node instanceof HTMLElement ? node : null;
      floatingRef.current = element;
      setOverlayScope(element);
    },
    [floatingRef, setOverlayScope],
  );

  useEffect(() => {
    const element = inputRef.current?.getNativeRef();
    if (!(element instanceof HTMLElement)) return;
    // The box mounts off-screen until it is measured; scrolling to it would move the chat.
    element.focus({ preventScroll: true });
  }, []);

  // No fade-in: Reanimated hides an entering view until its animation starts, and a
  // hidden input cannot take focus.
  return (
    <AnchoredSurface
      range={range}
      alignment="start"
      layer={layer}
      style={styles.noteSurface}
      surfaceRef={setSurface}
      testID="assistant-selection-quote-note"
    >
      <EditingTextInput
        ref={inputRef}
        multiline
        accessibilityLabel={t("agentStream.quote.noteLabel")}
        placeholder={t("agentStream.quote.notePlaceholder")}
        placeholderTextColor={styles.placeholder.color}
        onChangeText={handleChangeText}
        style={styles.noteInput}
        testID="assistant-selection-quote-note-input"
      />
      <Text style={styles.hint}>{t("agentStream.quote.hint")}</Text>
    </AnchoredSurface>
  );
}

function AnchoredSurface({
  range,
  alignment,
  layer,
  entering,
  style,
  surfaceRef,
  testID,
  children,
}: {
  range: Range;
  alignment: Alignment;
  layer: number;
  entering?: FloatingSurfaceProps["entering"];
  style?: StyleProp<ViewStyle>;
  /** The whole floating surface, padding included, so a press on its rim stays inside. */
  surfaceRef: (node: View | null) => void;
  testID: string;
  children: ReactNode;
}) {
  const anchor = useRangeEndRect(range);
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
 * The last line box of the range, followed through scrolling. A range whose text the
 * stream re-rendered away has no box left, so the surface stays where it last was.
 */
function useRangeEndRect(range: Range): Rect | null {
  const [rect, setRect] = useState<Rect | null>(() => rangeEndRect(range));
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const next = rangeEndRect(range);
      if (next) setRect(next);
    };
    const scheduleMeasure = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    measure();
    document.addEventListener("scroll", scheduleMeasure, true);
    window.addEventListener("resize", scheduleMeasure);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("scroll", scheduleMeasure, true);
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [range]);
  return rect;
}

function rangeEndRect(range: Range): Rect | null {
  const last = Array.from(range.getClientRects()).findLast((box) => box.width > 0);
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
 * terminal, or a control Enter presses. Only Enter that would otherwise do nothing opens
 * the note box.
 */
function focusReadsEnter(target: EventTarget | null): boolean {
  if (resolveKeyboardFocusScope({ target, commandCenterOpen: false }) !== "other") return true;
  return target instanceof HTMLElement && target !== document.body && target.tabIndex >= 0;
}

/**
 * Swallows the repeats of an Enter that is still held after the note box gave focus away,
 * until the key comes up, so a held Enter cannot send the draft it just added to.
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
  noteSurface: {
    width: 320,
    padding: theme.spacing[2],
    gap: theme.spacing[1.5],
  },
  noteInput: {
    height: theme.fontSize.content * 1.4 * 3 + theme.spacing[2] * 2,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.content,
    lineHeight: theme.fontSize.content * 1.4,
    outlineWidth: 0,
    outlineColor: "transparent",
  },
  placeholder: {
    color: theme.colors.foregroundMuted,
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
