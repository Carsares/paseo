import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useCheckpointCopy } from "@/git/diff-checkpoint-copy";

interface RewindFileRetryProps {
  conversationRewound: boolean;
  detail: string | null;
  retry: () => Promise<void>;
}

export function RewindFileRetry({ conversationRewound, detail, retry }: RewindFileRetryProps) {
  const copy = useCheckpointCopy();
  const [error, setError] = useState(detail);
  const [pending, setPending] = useState(false);
  const handleRetry = useCallback(async () => {
    setPending(true);
    try {
      await retry();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.fileRewindFailed);
    } finally {
      setPending(false);
    }
  }, [copy.fileRewindFailed, retry]);
  return (
    <View style={styles.container}>
      <Text style={styles.text}>
        {conversationRewound ? copy.partialRewind : copy.fileRewindFailed}
      </Text>
      {error ? <Text style={styles.text}>{error}</Text> : null}
      <Button variant="secondary" size="sm" disabled={pending} onPress={handleRetry}>
        {copy.retryFiles}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { gap: theme.spacing[2], alignItems: "flex-start", flexShrink: 1 },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
