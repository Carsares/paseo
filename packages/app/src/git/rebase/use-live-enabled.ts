import { useLayoutEffect, useRef } from "react";

export function useLiveEnabled(enabled: boolean) {
  const live = useRef(false);
  useLayoutEffect(() => {
    live.current = enabled;
    return () => {
      live.current = false;
    };
  }, [enabled]);
  return live;
}
