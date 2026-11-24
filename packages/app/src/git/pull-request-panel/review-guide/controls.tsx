import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { Button } from "@/components/ui/button";
import { openExternalUrl } from "@/utils/open-external-url";
import { reviewErrorCopy, useReviewGuideCopy } from "./copy";
import type { ReviewFailure, ReviewStop, ReviewVersion } from "./port";
import { styles } from "./styles";

export type AttachReviewStop = (version: ReviewVersion, stop: ReviewStop, body: string) => void;

export function ReviewError({
  failure,
  viewed = false,
}: {
  failure: ReviewFailure;
  viewed?: boolean;
}) {
  const copy = useReviewGuideCopy();
  return (
    <View accessibilityLiveRegion="polite" style={styles.content}>
      <Text style={styles.error}>
        {copy(
          viewed && failure.code === "unknown_outcome"
            ? "viewedUnknownOutcome"
            : reviewErrorCopy[failure.code],
        )}
      </Text>
      {failure.message ? <Text style={styles.secondary}>{failure.message}</Text> : null}
    </View>
  );
}

export function OpenReviewButton({ url }: { url: string }) {
  const copy = useReviewGuideCopy();
  const open = useCallback(() => {
    void openExternalUrl(url);
  }, [url]);
  return (
    <Button variant="ghost" size="sm" onPress={open}>
      {copy("openOnForge")}
    </Button>
  );
}

export function AttachReviewButton({
  attach,
  version,
  stop,
  body,
}: {
  attach: AttachReviewStop;
  version: ReviewVersion;
  stop: ReviewStop;
  body: string;
}) {
  const copy = useReviewGuideCopy();
  const [attachedBody, setAttachedBody] = useState<string>();
  const add = useCallback(() => {
    attach(version, stop, body);
    setAttachedBody(body);
  }, [attach, version, stop, body]);
  return (
    <View style={styles.actions}>
      <Button variant="secondary" size="sm" onPress={add}>
        {copy("addToChat")}
      </Button>
      {attachedBody === body ? (
        <Text accessibilityLiveRegion="polite" style={styles.secondary}>
          {copy("attached")}
        </Text>
      ) : null}
    </View>
  );
}
