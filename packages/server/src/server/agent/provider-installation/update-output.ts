import type { AgentClientUpdateContext } from "../agent-sdk-types.js";

const MAX_LINE = 4096;
const CLAUDE_CURRENT = /^Claude Code is up to date \((\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\)[.!]?$/u;

const PHASES = [
  [/\bchecking\b/i, "Updater is checking for a release."],
  [/\bdownload(?:ing)?\b/i, "Updater is downloading files."],
  [/\binstall(?:ing)?\b/i, "Updater is installing files."],
  [
    /\balready (?:up.to.date|on the latest)\b/i,
    "Updater reports the current version is installed.",
  ],
  [/\b(?:permission denied|EACCES)\b/i, "Updater encountered a permission error."],
] as const;

/** Never forward vendor output verbatim; it can contain environment values, paths or argv. */
export function createUpdateOutput(report: AgentClientUpdateContext["report"]) {
  let line = "";
  let overflow = false;
  let currentVersion: string | undefined;
  const seen = new Set<string>();

  function flush() {
    if (!overflow) {
      const current = CLAUDE_CURRENT.exec(line.trim())?.[1];
      if (current) currentVersion = current;
      const phase = PHASES.find(([pattern]) => pattern.test(line))?.[1];
      if (phase && !seen.has(phase)) {
        seen.add(phase);
        report({ type: "message", text: `${phase}\n` });
      }
    }
    line = "";
    overflow = false;
  }

  return {
    write(text: string) {
      let from = 0;
      while (from < text.length) {
        const end = text.indexOf("\n", from);
        const length = (end < 0 ? text.length : end) - from;
        if (line.length + length > MAX_LINE) overflow = true;
        if (!overflow) line += text.slice(from, from + length);
        if (end < 0) return;
        flush();
        from = end + 1;
      }
    },
    end: flush,
    get currentVersion() {
      return currentVersion;
    },
  };
}

const SAFE_PROGRESS = new Set([
  "Verifying the Claude Code installation.",
  "Running the verified native updater.",
  "Verifying the version selected by the original Claude Code command.",
  ...PHASES.map(([, copy]) => copy),
]);

const SAFE_RESULTS = new Set([
  "This installation is in use by a Paseo agent. Close its runtime before updating.",
  "An update is already in progress for this installation.",
  "The verified Claude Code installation changed. Inspect it and retry.",
  "Claude Code did not report the version recorded by its native installer.",
  "The Claude Code executable changed before launch. Inspect it and retry.",
  "The original Claude Code command no longer resolves to the same installation.",
  "Claude Code could not be verified after the update.",
  "The original Claude Code command now reports an older release.",
  "Claude Code is usable, but Paseo could not confirm that it is on the latest release.",
  "The native command timed out.",
  "Could not start the verified executable.",
  "Could not confirm the updater process tree stopped.",
  "This platform or executable is unsupported for native updates.",
  "Update canceled.",
  "Update OpenCode on the host that manages the connected server.",
]);

/** Project updater text to fixed user-facing copy before retaining, streaming or logging it. */
export function sanitizeUpdateProgress(text: string): string | undefined {
  if (text.length > MAX_LINE) return undefined;
  const normalized = text.trim();
  if (!SAFE_PROGRESS.has(normalized)) return undefined;
  return `${normalized}\n`;
}

export function sanitizeUpdateResultMessage(message: string | undefined): string | undefined {
  if (!message || message.length > MAX_LINE) return undefined;
  if (SAFE_RESULTS.has(message)) return message;
  const release =
    /^Claude Code (?:updated to \d{1,8}\.\d{1,8}\.\d{1,8}|\d{1,8}\.\d{1,8}\.\d{1,8} is already current)\.$/u;
  const exit =
    /^The native updater (?:exited with code -?\d{1,10}|stopped \((?:SIG[A-Z]{1,12}|unknown signal)\))\.$/u;
  return release.test(message) || exit.test(message) ? message : undefined;
}
