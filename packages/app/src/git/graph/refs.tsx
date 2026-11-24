import { Text, View, ScrollView } from "react-native";
import { useTranslation } from "react-i18next";
import type { CheckoutGitRepo, CheckoutGitRepoRefs } from "@getpaseo/protocol/messages";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PressHighlight } from "@/components/ui/press-highlight";
import { CONTROL_HEIGHTS } from "@/components/ui/control-geometry";
import { useStableEvent } from "@/hooks/use-stable-event";
import { density } from "@/styles/density";
import { StyleSheet } from "react-native-unistyles";
import { RepoDot, styles } from "./ui";
import { referenceGroups } from "./ref-model";

export function RefBrowser({
  repos,
  refs,
  focusRef,
  inline,
}: {
  repos: readonly CheckoutGitRepo[];
  refs: readonly CheckoutGitRepoRefs[];
  focusRef: (repoRoot: string, ref: string) => void;
  inline: boolean;
}) {
  const { t } = useTranslation();
  const title = t("gitWorkbench.graph.refs");
  const repoGroups = repos.map((repo) => ({
    repo,
    groups: refs.flatMap((item) => (item.repoRoot === repo.repoRoot ? referenceGroups(item) : [])),
  }));
  if (inline) {
    return (
      <ScrollView>
        <View style={styles.stack}>
          <Text style={styles.heading}>{title}</Text>
          {repoGroups.map(({ repo, groups }) => (
            <View key={repo.repoRoot} style={styles.stack}>
              <View style={styles.row}>
                <RepoDot root={repo.repoRoot} />
                <Text numberOfLines={1} style={styles.heading}>
                  {repo.displayName}
                </Text>
              </View>
              {groups
                .filter(({ entries }) => entries.length > 0)
                .map(({ kind, label, entries }) => (
                  <View key={label ?? kind}>
                    <Text style={styles.muted}>
                      {t(`gitWorkbench.graph.${kind}`)}
                      {label ? ` · ${label}` : ""}
                    </Text>
                    {entries.map((entry) => (
                      <RefRow
                        key={entry.ref}
                        entry={entry}
                        root={repo.repoRoot}
                        onSelect={focusRef}
                        inline
                      />
                    ))}
                  </View>
                ))}
            </View>
          ))}
        </View>
      </ScrollView>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger style={localStyles.trigger}>
        <Text style={styles.heading}>{title}</Text>
      </DropdownMenuTrigger>
      <DropdownMenuContent sheetTitle={title} maxHeight={440} scrollable>
        {repoGroups.flatMap(({ repo, groups }) =>
          groups
            .filter(({ entries }) => entries.length > 0)
            .flatMap(({ kind, label, entries }) => {
              const rows = entries.map((entry) => (
                <RefRow
                  key={JSON.stringify([repo.repoRoot, entry.ref])}
                  entry={entry}
                  root={repo.repoRoot}
                  onSelect={focusRef}
                />
              ));
              rows.unshift(
                <DropdownMenuLabel key={JSON.stringify([repo.repoRoot, kind, label])}>
                  {repo.displayName} · {t(`gitWorkbench.graph.${kind}`)}
                  {label ? ` · ${label}` : ""}
                </DropdownMenuLabel>,
              );
              return rows;
            }),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RefRow({
  entry,
  root,
  onSelect,
  inline = false,
}: {
  entry: { name: string; ref: string; sha: string };
  root: string;
  onSelect: (root: string, ref: string) => void;
  inline?: boolean;
}) {
  const select = useStableEvent(() => onSelect(root, entry.ref));
  if (!inline) return <DropdownMenuItem onSelect={select}>{entry.name}</DropdownMenuItem>;
  return (
    <PressHighlight
      accessibilityRole="button"
      onPress={select}
      style={localStyles.refRow}
      highlightStyle={localStyles.highlight}
    >
      <Text style={styles.text} numberOfLines={1}>
        {entry.name}
      </Text>
    </PressHighlight>
  );
}

const localStyles = StyleSheet.create((theme) => ({
  trigger: {
    minHeight: CONTROL_HEIGHTS.md,
    justifyContent: "center",
    paddingHorizontal: theme.spacing[2],
  },
  refRow: {
    minHeight: density.rowHeight,
    justifyContent: "center",
    paddingStart: theme.spacing[3],
  },
  highlight: { backgroundColor: theme.colors.surface2 },
}));
