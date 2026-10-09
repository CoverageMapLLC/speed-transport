/**
 * Hands out per-client connection slots. A single process answers synchronously; a cluster
 * worker asks the primary process and answers with a promise.
 */
export interface ConnectionLimiter {
  acquire(key: string): boolean | Promise<boolean>;
  release(key: string): void;
}

/** Counts open sessions per key and refuses more than `maxPerKey`. */
export class ConnectionCounter implements ConnectionLimiter {
  private readonly counts = new Map<string, number>();

  constructor(readonly maxPerKey: number) {}

  acquire(key: string): boolean {
    const current = this.counts.get(key) ?? 0;
    if (current >= this.maxPerKey) return false;
    this.counts.set(key, current + 1);
    return true;
  }

  release(key: string): void {
    const current = this.counts.get(key) ?? 0;
    if (current <= 1) this.counts.delete(key);
    else this.counts.set(key, current - 1);
  }

  count(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  get total(): number {
    let total = 0;
    for (const value of this.counts.values()) total += value;
    return total;
  }
}
