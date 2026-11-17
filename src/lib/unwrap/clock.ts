/** Epoch milliseconds. Unlike performance.now(), the value is comparable
 * across workers and threads. */
export function nowEpoch(): number {
  return performance.timeOrigin + performance.now();
}
