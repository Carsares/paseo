import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { DiffViewer } from "@/components/diff-viewer";
import { reviewLineLabel, reviewStopDiff } from "./diff";
import { reviewDraftKey, useReviewDrafts } from "./drafts";
import { useReviewGuideCopy } from "./copy";
import {
  AttachReviewButton,
  OpenReviewButton,
  ReviewError,
  type AttachReviewStop,
} from "./controls";
import {
  reviewFailure,
  type ReviewCommentRequest,
  type ReviewFailure,
  type ReviewGuide,
  type ReviewGuideConnection,
  type ReviewStop,
  type ReviewTarget,
  type ReviewViewedEntry,
} from "./port";
import { styles } from "./styles";
import { useReviewViewed } from "./viewed";
import type { LocalReviewRequest } from "./local-viewed";

interface ReviewStopsProps {
  guide: ReviewGuide;
  target: ReviewTarget;
  connection: ReviewGuideConnection;
  queryToken: string;
  localRequest: LocalReviewRequest | undefined;
  scope: string;
  url: string;
  attach?: AttachReviewStop;
}

function groupByPath(stops: ReviewStop[]) {
  const files = new Map<string, ReviewStop[]>();
  for (const stop of stops) {
    const samePath = files.get(stop.path);
    if (samePath) samePath.push(stop);
    else files.set(stop.path, [stop]);
  }
  return files;
}

function mustRefresh(failure: ReviewFailure | undefined) {
  return (
    failure?.code === "stale" || failure?.code === "expired" || failure?.code === "invalid_target"
  );
}

export function ReviewStops(props: ReviewStopsProps) {
  const { guide, target, connection, queryToken, scope, url } = props;
  const copy = useReviewGuideCopy();
  const [selection, setSelection] = useState(0);
  const [stale, setStale] = useState<ReviewFailure>();
  const [publishedStopId, setPublishedStopId] = useState<string>();
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const invalidate = useCallback((failure: ReviewFailure) => {
    if (mustRefresh(failure)) setStale(failure);
  }, []);
  const viewed = useReviewViewed(
    connection.port,
    guide,
    target,
    scope,
    queryToken,
    props.localRequest,
    invalidate,
  );

  const files = useMemo(() => groupByPath(guide.stops), [guide.stops]);
  const active = guide.stops[selection];
  const activeFile = active ? files.get(active.path) : undefined;
  const versionFailure = stale ?? (mustRefresh(viewed.failure) ? viewed.failure : undefined);
  const publish = useCallback(
    async (stop: ReviewStop) => {
      if (versionFailure) return;
      const store = useReviewDrafts.getState();
      const next = store.begin(scope, guide.version, stop.id);
      if (!next?.attempt) return;
      const { operationId } = next.attempt;
      const request: ReviewCommentRequest = {
        ...target,
        version: guide.version,
        stopId: stop.id,
        body: next.body,
        operationId,
      };
      try {
        await connection.port.publishReviewComment(request);
      } catch (error) {
        const problem = reviewFailure(error, "unknown_outcome");
        store.finish(scope, guide.version, stop.id, operationId, problem);
        if (mounted.current) invalidate(problem);
        return;
      }
      store.finish(scope, guide.version, stop.id, operationId);
      if (!mounted.current) return;
      setPublishedStopId(stop.id);
      connection.onCommentPublished?.(request);
    },
    [connection, guide.version, invalidate, scope, target, versionFailure],
  );

  const select = useCallback(
    (stop: ReviewStop) => setSelection(guide.stops.indexOf(stop)),
    [guide.stops],
  );
  const previousStop = useCallback(() => setSelection((index) => Math.max(0, index - 1)), []);
  const nextStop = useCallback(
    () => setSelection((index) => Math.min(guide.stops.length - 1, index + 1)),
    [guide.stops.length],
  );
  const publishActive = useCallback(
    () => (active ? publish(active) : Promise.resolve()),
    [active, publish],
  );
  const clearPublication = useCallback(() => setPublishedStopId(undefined), []);

  return (
    <View style={styles.content}>
      <GuideCoverage guide={guide} url={url} />
      {active && activeFile ? (
        <>
          <View style={styles.actions}>
            <Text style={styles.secondary}>
              {copy(guide.viewedMode === "local" ? "viewedLocal" : "viewedRemote")}
            </Text>
            {viewed.failure || viewed.hasMore ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={viewed.loading || !!viewed.pendingPath}
                onPress={viewed.reload}
              >
                {copy("retryViewed")}
              </Button>
            ) : null}
          </View>
          {viewed.failure ? <ReviewError failure={viewed.failure} viewed /> : null}
          {viewed.hasMore ? <Text style={styles.secondary}>{copy("viewedPartial")}</Text> : null}
          <ReviewFiles
            files={files}
            selectedPath={active.path}
            viewed={viewed}
            canWrite={!versionFailure}
            localViewed={guide.viewedMode === "local"}
            onSelect={select}
          />
          <View style={styles.actions}>
            <Button variant="ghost" size="sm" disabled={selection === 0} onPress={previousStop}>
              {copy("previousStop")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={selection === guide.stops.length - 1}
              onPress={nextStop}
            >
              {copy("nextStop")}
            </Button>
          </View>
          <View style={styles.actions}>
            {activeFile.map((stop) => (
              <ReviewStopButton
                key={stop.id}
                stop={stop}
                selected={stop === active}
                onSelect={select}
              />
            ))}
          </View>
          {versionFailure && versionFailure !== viewed.failure ? (
            <ReviewError failure={versionFailure} />
          ) : null}
          <SelectedReviewStop
            key={active.id}
            {...props}
            stop={active}
            canPublish={!versionFailure}
            published={publishedStopId === active.id}
            onPublish={publishActive}
            onDraftEdit={clearPublication}
          />
        </>
      ) : (
        <Text style={styles.secondary}>{copy("empty")}</Text>
      )}
    </View>
  );
}

function GuideCoverage({ guide, url }: { guide: ReviewGuide; url: string }) {
  const copy = useReviewGuideCopy();
  const { filesLoaded, totalFiles, hasMore, missingPatches } = guide.coverage;
  return (
    <View style={styles.content}>
      <Text style={styles.secondary}>
        {totalFiles === undefined
          ? copy("filesLoaded", { count: filesLoaded })
          : copy("filesLoadedOfTotal", { loaded: filesLoaded, total: totalFiles })}
      </Text>
      {missingPatches > 0 ? (
        <Text style={styles.secondary}>{copy("missingPatches", { count: missingPatches })}</Text>
      ) : null}
      {hasMore ? <Text style={styles.secondary}>{copy("partial")}</Text> : null}
      {hasMore || missingPatches > 0 ? <OpenReviewButton url={url} /> : null}
    </View>
  );
}

function ReviewFiles({
  files,
  selectedPath,
  viewed,
  canWrite,
  localViewed,
  onSelect,
}: {
  files: Map<string, ReviewStop[]>;
  selectedPath: string;
  viewed: ReturnType<typeof useReviewViewed>;
  canWrite: boolean;
  localViewed: boolean;
  onSelect: (stop: ReviewStop) => void;
}) {
  return (
    <View style={styles.list}>
      {[...files].map(([path, stops]) => {
        const state =
          viewed.entries.get(path) ?? (localViewed && viewed.loaded ? "unviewed" : undefined);
        return (
          <ReviewFile
            key={path}
            path={path}
            selected={selectedPath === path}
            state={state}
            canWrite={canWrite && viewed.canWrite && state !== undefined}
            progress={viewed.pendingPath === path}
            firstStop={stops[0]}
            onSelect={onSelect}
            onSetViewed={viewed.setViewed}
          />
        );
      })}
    </View>
  );
}

function ReviewFile({
  path,
  selected,
  state,
  canWrite,
  progress,
  firstStop,
  onSelect,
  onSetViewed,
}: {
  path: string;
  selected: boolean;
  state: ReviewViewedEntry["state"] | undefined;
  canWrite: boolean;
  progress: boolean;
  firstStop: ReviewStop;
  onSelect: (stop: ReviewStop) => void;
  onSetViewed: (path: string, viewed: boolean) => Promise<void>;
}) {
  const copy = useReviewGuideCopy();
  const confirmViewed = state !== "viewed";
  const select = useCallback(() => onSelect(firstStop), [onSelect, firstStop]);
  const toggleViewed = useCallback(() => {
    void onSetViewed(path, confirmViewed);
  }, [onSetViewed, path, confirmViewed]);
  const selection = useMemo(() => ({ selected }), [selected]);
  return (
    <View style={styles.file}>
      <View style={styles.fileRow}>
        <Button
          variant={selected ? "secondary" : "ghost"}
          size="sm"
          onPress={select}
          accessibilityState={selection}
        >
          {path}
        </Button>
        <Text style={styles.secondary}>{copy(state ?? "viewedUnknown")}</Text>
        <Button
          variant="ghost"
          size="sm"
          disabled={!canWrite}
          loading={progress}
          onPress={toggleViewed}
        >
          {copy(confirmViewed ? "markViewed" : "markUnviewed")}
        </Button>
      </View>
    </View>
  );
}

function ReviewStopButton({
  stop,
  selected,
  onSelect,
}: {
  stop: ReviewStop;
  selected: boolean;
  onSelect: (stop: ReviewStop) => void;
}) {
  const copy = useReviewGuideCopy();
  const select = useCallback(() => onSelect(stop), [onSelect, stop]);
  const label = reviewLineLabel(stop.line);
  const selection = useMemo(() => ({ selected }), [selected]);
  return (
    <Button
      variant={selected ? "secondary" : "ghost"}
      size="sm"
      onPress={select}
      accessibilityState={selection}
    >
      {label ? `${copy(stop.reason)} · ${label}` : copy(stop.reason)}
    </Button>
  );
}

function SelectedReviewStop({
  guide,
  scope,
  url,
  attach,
  stop,
  canPublish,
  published,
  onPublish,
  onDraftEdit,
}: ReviewStopsProps & {
  stop: ReviewStop;
  canPublish: boolean;
  published: boolean;
  onPublish: () => Promise<void>;
  onDraftEdit: () => void;
}) {
  const copy = useReviewGuideCopy();
  const diff = useMemo(() => reviewStopDiff(stop), [stop]);
  const line = reviewLineLabel(diff.line);
  const canComment = guide.commentMode === "remote" && !!diff.line;
  const rename =
    stop.oldPath && stop.oldPath !== stop.path ? `${stop.oldPath} → ${stop.path}` : stop.path;
  return (
    <View style={styles.content}>
      <Text style={styles.path}>{rename}</Text>
      <Text style={styles.secondary}>
        {[copy(stop.priority), copy(stop.reason), line].filter(Boolean).join(" · ")}
      </Text>
      <DiffViewer diffLines={diff.lines} emptyLabel={copy("unavailable")} />
      {canComment ? null : (
        <Text style={styles.secondary}>
          {copy(diff.line ? "commentChatOnly" : "noInlineLocation")}
        </Text>
      )}
      <ReviewDraftEditor
        guide={guide}
        scope={scope}
        url={url}
        attach={attach}
        stop={stop}
        canComment={canComment}
        canPublish={canPublish}
        published={published}
        onPublish={onPublish}
        onDraftEdit={onDraftEdit}
      />
    </View>
  );
}

function ReviewDraftEditor({
  guide,
  scope,
  url,
  attach,
  stop,
  canComment,
  canPublish,
  published,
  onPublish,
  onDraftEdit,
}: Pick<ReviewStopsProps, "guide" | "scope" | "url" | "attach"> & {
  stop: ReviewStop;
  canComment: boolean;
  canPublish: boolean;
  published: boolean;
  onPublish: () => Promise<void>;
  onDraftEdit: () => void;
}) {
  const copy = useReviewGuideCopy();
  const key = reviewDraftKey(guide.version, stop.id);
  const draft = useReviewDrafts((state) => state.scopes[scope]?.[key]);
  const input = useRef<EditingTextInputHandle>(null);
  useLayoutEffect(() => {
    if (published) input.current?.reset();
  }, [published]);
  const body = draft?.body ?? "";
  const attempt = draft?.attempt;
  const failure = attempt?.failure;
  const publishing = !!attempt && !failure;
  const unknown = failure?.code === "unknown_outcome";

  const edit = useCallback(
    (text: string) => {
      onDraftEdit();
      useReviewDrafts.getState().edit(scope, guide.version, stop, text);
    },
    [onDraftEdit, scope, guide.version, stop],
  );

  return (
    <View style={styles.content}>
      {canComment || attach ? (
        <FormTextInput
          ref={input}
          accessibilityLabel={copy("draft")}
          placeholder={copy("draft")}
          style={styles.draft}
          multiline
          initialValue={body}
          editable={!publishing && !unknown}
          onChangeText={edit}
        />
      ) : null}
      {failure ? <ReviewError failure={failure} /> : null}
      {published ? (
        <Text accessibilityLiveRegion="polite" style={styles.secondary}>
          {copy("published")}
        </Text>
      ) : null}
      <View style={styles.actions}>
        {canComment && !unknown ? (
          <Button
            size="sm"
            loading={publishing}
            disabled={!body.trim() || !canPublish}
            onPress={onPublish}
          >
            {copy("publish")}
          </Button>
        ) : null}
        {failure || !canComment ? <OpenReviewButton url={url} /> : null}
      </View>
      {attach ? (
        <AttachReviewButton attach={attach} version={guide.version} stop={stop} body={body} />
      ) : null}
    </View>
  );
}
