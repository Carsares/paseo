export function orderProviders<T>(
  providers: readonly T[],
  getStatus: (provider: T) => { enabled: boolean; hasError: boolean },
): T[] {
  const enabled: T[] = [];
  const disabled: T[] = [];
  const errors: T[] = [];
  for (const provider of providers) {
    const status = getStatus(provider);
    if (status.hasError) errors.push(provider);
    else if (status.enabled) enabled.push(provider);
    else disabled.push(provider);
  }
  return [...enabled, ...disabled, ...errors];
}
