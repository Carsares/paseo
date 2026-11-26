import { memo, useEffect, useRef, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { isWeb } from "@/constants/platform";

interface DomHoverNode {
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

export interface HoverEnvelopeProps {
  style?: StyleProp<ViewStyle>;
  testID?: string;
  onHoverChange: (hovered: boolean) => void;
  children: ReactNode;
}

/**
 * Plain View hover envelope that attaches non-bubbling DOM mouseenter/mouseleave listeners on web
 * without using Pressable hover state machines or JSX pointer-enter props. On native platforms,
 * hover is unreachable and callers rely on `isHovered || isNative || isCompact`.
 */
export const HoverEnvelope = memo(function HoverEnvelope({
  style,
  testID,
  onHoverChange,
  children,
}: HoverEnvelopeProps) {
  const viewRef = useRef<View>(null);

  useEffect(() => {
    if (!isWeb) return;
    const node = viewRef.current as unknown as DomHoverNode | null;
    if (!node || typeof node.addEventListener !== "function") return;
    const handleEnter = () => onHoverChange(true);
    const handleLeave = () => onHoverChange(false);
    node.addEventListener("mouseenter", handleEnter);
    node.addEventListener("mouseleave", handleLeave);
    return () => {
      node.removeEventListener?.("mouseenter", handleEnter);
      node.removeEventListener?.("mouseleave", handleLeave);
    };
  }, [onHoverChange]);

  return (
    <View ref={viewRef} style={style} testID={testID}>
      {children}
    </View>
  );
});
