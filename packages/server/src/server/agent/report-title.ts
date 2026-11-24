const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveReportTitle(
  agentId: string,
  ...candidates: Array<string | null | undefined>
): string | undefined {
  for (const candidate of candidates) {
    const title = candidate?.trim();
    if (title && title.toLowerCase() !== agentId.toLowerCase() && !UUID.test(title)) return title;
  }
  return undefined;
}
