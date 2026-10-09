/**
 * Fills in `defaults` for every key `overrides` leaves out or sets to `undefined`. A plain
 * spread would let `{ limit: undefined }` replace a default with `undefined`, which turns
 * limits such as backpressure off.
 */
export function withDefaults<T extends object>(defaults: T, overrides?: Partial<NoInfer<T>> | null): T {
  const result = { ...defaults };
  if (!overrides) return result;
  for (const key of Object.keys(overrides) as Array<keyof T>) {
    const value = overrides[key];
    if (value !== undefined) result[key] = value as T[keyof T];
  }
  return result;
}
