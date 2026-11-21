import { describe, expect, it } from "vitest";
import {
  createActivePromptPublisher,
  shouldAcceptPromptIndexEpoch,
  promptTickMagnification,
  resolveActivePromptReadingState,
  resolveActivePromptSeq,
  OUTLINE_MAGNIFY_RADIUS,
  type ActivePromptReadingState,
  type ChatOutlinePrompt,
} from "./model";

describe("chat outline prompt index epoch", () => {
  it("accepts only the authoritative timeline epoch", () => {
    expect(shouldAcceptPromptIndexEpoch("epoch-2", "epoch-2")).toBe(true);
    expect(shouldAcceptPromptIndexEpoch("epoch-2", "epoch-1")).toBe(false);
  });
});

function prompt(seq: number): ChatOutlinePrompt {
  return { seq, timestamp: new Date(seq).toISOString(), preview: `prompt ${seq}` };
}

describe("promptTickMagnification", () => {
  it("peaks under the pointer and decays to nothing at the radius", () => {
    expect(promptTickMagnification(0)).toBe(1);
    expect(promptTickMagnification(OUTLINE_MAGNIFY_RADIUS)).toBe(0);
    expect(promptTickMagnification(OUTLINE_MAGNIFY_RADIUS + 10)).toBe(0);
  });

  it("falls off monotonically and symmetrically around the pointer", () => {
    const above = [0, 1, 2, 3].map((distance) => promptTickMagnification(distance));
    const below = [0, -1, -2, -3].map((distance) => promptTickMagnification(distance));

    expect(above).toEqual(below);
    expect(above).toEqual([...above].sort((left, right) => right - left));
  });
});

describe("resolveActivePromptSeq", () => {
  const prompts = [prompt(2), prompt(9), prompt(20)];

  it("marks the prompt whose turn the reading position sits in", () => {
    expect(resolveActivePromptSeq(prompts, 9)).toBe(9);
    expect(resolveActivePromptSeq(prompts, 14)).toBe(9);
    expect(resolveActivePromptSeq(prompts, 20)).toBe(20);
    expect(resolveActivePromptSeq(prompts, 99)).toBe(20);
  });

  it("marks nothing above the first prompt or without a reading position", () => {
    expect(resolveActivePromptSeq(prompts, 1)).toBeNull();
    expect(resolveActivePromptSeq(prompts, null)).toBeNull();
    expect(resolveActivePromptSeq([], 42)).toBeNull();
  });
});

describe("resolveActivePromptReadingState", () => {
  const prompts = [prompt(2), prompt(9)];

  it("hides the bar before the first prompt or without a reading position", () => {
    const hidden = { activeSeq: null, isPromptScrolledAbove: false };
    expect(resolveActivePromptReadingState(prompts, 1)).toEqual(hidden);
    expect(resolveActivePromptReadingState(prompts, null)).toEqual(hidden);
  });

  it("hides the bar at the prompt row and shows it while reading the rest of the turn", () => {
    expect(resolveActivePromptReadingState(prompts, 9, true)).toEqual({
      activeSeq: 9,
      isPromptScrolledAbove: false,
    });
    const scrolled = { activeSeq: 9, isPromptScrolledAbove: true };
    expect(resolveActivePromptReadingState(prompts, 10)).toEqual(scrolled);
    expect(resolveActivePromptReadingState(prompts, 9, false)).toEqual(scrolled);
    expect(resolveActivePromptReadingState(prompts, 10, true)).toEqual(scrolled);
  });
});

describe("createActivePromptPublisher", () => {
  it("only changes the snapshot and notifies when the prompt or its visibility changes", () => {
    const publisher = createActivePromptPublisher();
    const snapshots: ActivePromptReadingState[] = [];
    const unsubscribe = publisher.subscribe(() => {
      snapshots.push(publisher.getReadingState());
    });

    const initial = publisher.getReadingState();
    publisher.publish(null);
    expect(publisher.getReadingState()).toBe(initial);

    publisher.publish(9);
    const promptRow = publisher.getReadingState();
    expect(promptRow).toEqual({ activeSeq: 9, isPromptScrolledAbove: false });
    publisher.publish(9, false);
    expect(publisher.getReadingState()).toBe(promptRow);

    publisher.publish(9, true);
    const scrolled = publisher.getReadingState();
    expect(scrolled).not.toBe(promptRow);
    expect(publisher.getActiveSeq()).toBe(9);
    publisher.publish(9, true);
    expect(publisher.getReadingState()).toBe(scrolled);

    publisher.publish(20, true);
    const next = publisher.getReadingState();
    expect(next).not.toBe(scrolled);
    unsubscribe();
    publisher.publish(null);

    expect(snapshots).toEqual([promptRow, scrolled, next]);
    expect(publisher.getActiveSeq()).toBeNull();
    expect(publisher.getReadingState()).toEqual(initial);
  });
});
