import { randomFillSync } from 'node:crypto';

/**
 * Bulk UUIDv7 (RFC 9562 §5.7, monotonic per RFC 9562 §6.2 method 1) for hot paths that create one id per recipient
 * (campaign materialization, Gate E). The `uuid` package allocated ~900 bytes per id (option objects, a 16-byte array, a
 * per-byte lookup concatenation); this draws randomness from a pooled buffer and builds the string from a few slices.
 *
 * Layout: 48-bit Unix milliseconds | version 7 | 12-bit counter (rand_a) | variant 10 | 62 random bits (rand_b).
 * Within one millisecond the counter increments from a random start below 2^11, so ids generated in sequence are
 * strictly increasing; if 4,096 ids are taken in one millisecond the timestamp borrows the next millisecond.
 */
const POOL_BYTES = 16 * 1024;
const pool = Buffer.allocUnsafe(POOL_BYTES);
let poolAt = POOL_BYTES;
let lastMs = -1;
let counter = 0;

function random(bytes: number): number {
  if (poolAt + bytes > POOL_BYTES) {
    randomFillSync(pool);
    poolAt = 0;
  }
  const at = poolAt;
  poolAt += bytes;
  return at;
}

export function uuidV7(now: number = Date.now()): string {
  if (now > lastMs) {
    lastMs = now;
    counter = pool.readUInt16BE(random(2)) & 0x7ff;
  } else if (++counter > 0xfff) {
    lastMs++;
    counter = 0;
  }
  const time = lastMs.toString(16).padStart(12, '0');
  const at = random(8);
  const variant = (0x8000 | (pool.readUInt16BE(at) & 0x3fff)).toString(16);
  return `${time.slice(0, 8)}-${time.slice(8)}-${(0x7000 | counter).toString(16)}-${variant}-${pool.toString('hex', at + 2, at + 8)}`;
}
