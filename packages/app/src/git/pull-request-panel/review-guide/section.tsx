import { useCallback, useId, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useFetchQuery } from "@/data/query";
import { useWorkspaceAttachmentsStore } from "@/attachments/workspace-attachments-store";
import { Button } from "@/components/ui/button";
import type { PrPaneData } from "../data";
import { SectionHeader, sectionKitStyles } from "../section-kit";
import { useReviewGuideCopy } from "./copy";
import {
  AttachReviewButton,
  OpenReviewButton,
  ReviewError,
  type AttachReviewStop,
} from "./controls";
import { reviewStopAttachment } from "./diff";
import { emptyDrafts, reviewDraftKey, useReviewDrafts } from "./drafts";
import { ReviewStops } from "./stops";
import { localReviewViewed } from "./local-viewed";
import {
  reviewFailure,
  reviewIdentityKey,
  reviewVersionKey,
  type ReviewGuide,
  type ReviewGuideConnection,
  type ReviewTarget,
  type ReviewVersion,
} from "./port";
import { styles } from "./styles";

interface ReviewGuideSectionProps {
  connection: ReviewGuideConnection;
  cwd: string;
  scope: string;
  title: string;
  url: string;
  attachmentScope?: string;
}

export function ReviewGuideSlot({
  connection,
  serverId,
  cwd,
  data,
  attachmentScope,
}: {
  connection?: ReviewGuideConnection;
  serverId: string;
  cwd: string;
  data: PrPaneData;
  attachmentScope?: string;
}) {
  if (
    !connection ||
    connection.identity.number !== data.number ||
    connection.identity.forge !== data.forge
  )
    return null;
  const scope = JSON.stringify([
    serverId,
    cwd,
    attachmentScope,
    data.url,
    reviewIdentityKey(connection.identity),
  ]);
  return (
    <ReviewGuideSection
      key={scope}
      connection={connection}
      cwd={cwd}
      scope={scope}
      title={data.title}
      url={data.url}
      attachmentScope={attachmentScope}
    />
  );
}

function ReviewGuideSection(props: ReviewGuideSectionProps) {
  const copy = useReviewGuideCopy();
  const [disclosure, setDisclosure] = useState<"initial" | "open" | "closed">("initial");
  const toggle = useCallback(
    () => setDisclosure((state) => (state === "open" ? "closed" : "open")),
    [],
  );
  const { expectedVersion } = props.connection;
  const versionKey = expectedVersion
    ? reviewVersionKey(expectedVersion)
    : (props.connection.observedHeadSha ?? "current");

  return (
    <View testID="pr-review-guide">
      <SectionHeader
        title={copy("title")}
        open={disclosure === "open"}
        onToggle={toggle}
        summary={null}
      />
      {disclosure === "initial" ? null : (
        <View style={disclosure === "open" ? sectionKitStyles.sectionBody : styles.hidden}>
          <ReviewGuideContent key={versionKey} {...props} />
        </View>
      )}
    </View>
  );
}

const REVIEW_READ_OPTIONS = {
  retry: false,
  dataShape: "value",
  immutableWhen: () => true,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

function validateGuide(guide: ReviewGuide, target: ReviewTarget, expectedVersion?: ReviewVersion) {
  if (reviewIdentityKey(guide.identity) !== reviewIdentityKey(target.identity)) {
    throw { code: "invalid_target" };
  }
  if (expectedVersion && reviewVersionKey(guide.version) !== reviewVersionKey(expectedVersion)) {
    throw { code: "stale" };
  }
  if (!guide.diffBaseSha) return guide;
  return {
    ...guide,
    stops: guide.stops.map((stop) => ({ ...stop, diffBaseSha: guide.diffBaseSha })),
  };
}

function ReviewGuideContent({
  connection,
  cwd,
  scope,
  title,
  url,
  attachmentScope,
}: ReviewGuideSectionProps) {
  const copy = useReviewGuideCopy();
  const instance = useId();
  const [generation, setGeneration] = useState(0);
  const target = useMemo(
    () => ({ cwd, identity: connection.identity }),
    [cwd, connection.identity],
  );
  const queryToken = `${instance}:${generation}`;
  const query = useFetchQuery({
    ...REVIEW_READ_OPTIONS,
    queryKey: ["pr-review-guide", scope, queryToken],
    queryFn: async ({ signal }) => {
      const localRequest = await localReviewViewed.begin(target.identity).catch(() => undefined);
      signal.throwIfAborted();
      const expected = generation === 0 ? connection.expectedVersion : undefined;
      const guide = await connection.port.getReviewGuide(
        generation > 0 ? { ...target, refresh: true } : { ...target, expectedVersion: expected },
      );
      signal.throwIfAborted();
      if (
        generation === 0 &&
        !expected &&
        connection.observedHeadSha &&
        guide.version.headSha !== connection.observedHeadSha
      ) {
        throw { code: "stale" };
      }
      return { guide: validateGuide(guide, target, expected), localRequest };
    },
  });

  const attachStop = useCallback<AttachReviewStop>(
    (version, stop, body) => {
      if (!attachmentScope) return;
      useWorkspaceAttachmentsStore.getState().addWorkspaceAttachment({
        scopeKey: attachmentScope,
        attachment: reviewStopAttachment({ scope, version, stop, body, url }),
      });
    },
    [attachmentScope, scope, url],
  );
  const attach = attachmentScope ? attachStop : undefined;
  const refresh = useCallback(() => setGeneration((value) => value + 1), []);
  const failure = query.isError ? reviewFailure(query.error) : undefined;

  return (
    <View style={styles.content}>
      <View style={styles.actions}>
        <Button variant="ghost" size="sm" disabled={query.isFetching} onPress={refresh}>
          {copy("refresh")}
        </Button>
        {query.isError ? <OpenReviewButton url={url} /> : null}
      </View>
      {query.isPending ? (
        <Text accessibilityLiveRegion="polite" style={styles.secondary}>
          {copy("loading")}
        </Text>
      ) : null}
      {failure ? <ReviewError failure={failure} /> : null}
      {failure?.code === "unsupported" && attachmentScope ? (
        <AttachChangeRequest scopeKey={attachmentScope} title={title} url={url} />
      ) : null}
      {query.data ? (
        <ReviewStops
          key={queryToken}
          guide={query.data.guide}
          localRequest={query.data.localRequest}
          target={target}
          connection={connection}
          queryToken={queryToken}
          scope={scope}
          url={url}
          attach={attach}
        />
      ) : null}
      <EarlierDrafts scope={scope} guide={query.data?.guide} attach={attach} url={url} />
    </View>
  );
}

function AttachChangeRequest({
  scopeKey,
  title,
  url,
}: {
  scopeKey: string;
  title: string;
  url: string;
}) {
  const { t } = useTranslation();
  const copy = useReviewGuideCopy();
  const [added, setAdded] = useState(false);
  const attach = useCallback(() => {
    useWorkspaceAttachmentsStore.getState().addWorkspaceAttachment({
      scopeKey,
      attachment: {
        kind: "forge.change_request_review",
        id: `review-request:${url}`,
        title,
        text: `${title}\n${url}`,
        url,
      },
    });
    setAdded(true);
  }, [scopeKey, title, url]);
  return (
    <View style={styles.actions}>
      <Button variant="secondary" size="sm" onPress={attach}>
        {t("workspace.git.pr.actions.addToChat")}
      </Button>
      {added ? (
        <Text accessibilityLiveRegion="polite" style={styles.secondary}>
          {copy("attached")}
        </Text>
      ) : null}
    </View>
  );
}

function EarlierDrafts({
  scope,
  guide,
  attach,
  url,
}: {
  scope: string;
  guide?: ReviewGuide;
  attach?: AttachReviewStop;
  url: string;
}) {
  const copy = useReviewGuideCopy();
  const drafts = useReviewDrafts((state) => state.scopes[scope] ?? emptyDrafts);
  const activeDraftKeys = new Set(
    guide?.stops.map((stop) => reviewDraftKey(guide.version, stop.id)),
  );
  const earlier = Object.entries(drafts).filter(([key]) => !activeDraftKeys.has(key));
  if (earlier.length === 0) return null;
  return (
    <View style={styles.content}>
      <Text style={styles.heading}>{copy("previousDrafts")}</Text>
      {earlier.map(([key, draft]) => (
        <View key={key} style={styles.content}>
          <Text style={styles.secondary}>
            {copy("previousDraft", {
              path: draft.stop.path,
              head: draft.version.headSha.slice(0, 12),
            })}
          </Text>
          <Text selectable style={styles.heading}>
            {draft.body}
          </Text>
          {draft.attempt?.failure ? <ReviewError failure={draft.attempt.failure} /> : null}
          {draft.attempt?.failure?.code === "unknown_outcome" ? (
            <OpenReviewButton url={url} />
          ) : null}
          {attach ? (
            <AttachReviewButton
              attach={attach}
              version={draft.version}
              stop={draft.stop}
              body={draft.body}
            />
          ) : null}
        </View>
      ))}
    </View>
  );
}
