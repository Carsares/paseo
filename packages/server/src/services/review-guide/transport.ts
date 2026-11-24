import type { z } from "zod";
import { parseCliHttpResponse } from "../change-request-poller.js";
import { ForgeAuthenticationError, ForgeCommandError } from "../forge-cli-command.js";
import { ReviewGuideError } from "./service.js";

export type ReviewCommand = (args: string[]) => Promise<string>;

export class ReviewHttpError extends Error {
  constructor(
    readonly status: number | null,
    readonly response: unknown,
    readonly rateLimited: boolean,
  ) {
    super("Forge API request failed");
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

export async function reviewHttp(command: ReviewCommand, args: string[]) {
  let output: string;
  try {
    output = await command(args);
  } catch (error) {
    if (error instanceof ForgeAuthenticationError) throw new ReviewGuideError("permission");
    if (error instanceof ForgeCommandError) {
      const { status, headers, body } = parseCliHttpResponse(error.stdout ?? "");
      const parsedStatus =
        Number(/(?:HTTP\s+|(?:^|\s)status(?: code)?[=: ]+)([45]\d\d)\b/i.exec(error.stderr)?.[1]) ||
        null;
      throw new ReviewHttpError(
        status ?? parsedStatus,
        parseJson(body),
        headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(error.stderr),
      );
    }
    throw new ReviewHttpError(null, null, false);
  }
  const { status, headers, body } = parseCliHttpResponse(output);
  const json = parseJson(body);
  if (status !== null && status >= 400) {
    throw new ReviewHttpError(status, json, headers.get("x-ratelimit-remaining") === "0");
  }
  return { json, headers };
}

export function readError(error: unknown): ReviewGuideError {
  if (error instanceof ReviewGuideError) return error;
  if (error instanceof ReviewHttpError && !error.rateLimited) {
    if (error.status === 401 || error.status === 403) return new ReviewGuideError("permission");
  }
  return new ReviewGuideError("unavailable");
}

export function writeError(error: unknown): ReviewGuideError {
  if (error instanceof ReviewGuideError && error.code === "permission") return error;
  if (
    error instanceof ReviewHttpError &&
    error.status !== null &&
    [400, 401, 403, 404, 409, 422, 429].includes(error.status)
  ) {
    return readError(error);
  }
  return new ReviewGuideError("unknown_outcome");
}

export function decode<T>(schema: z.ZodType<T>, json: unknown): T {
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ReviewGuideError("unavailable");
  return parsed.data;
}

export function safeProjectPath(path: string): boolean {
  return (
    path.length <= 512 &&
    path
      .split("/")
      .every((segment) => /^[a-z0-9_.-]+$/i.test(segment) && segment !== "." && segment !== "..")
  );
}

export function hasNextPage(headers: ReadonlyMap<string, string>) {
  return (
    /;\s*rel="next"/i.test(headers.get("link") ?? "") || Boolean(headers.get("x-next-page")?.trim())
  );
}
