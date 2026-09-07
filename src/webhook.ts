/**
 * Shared webhook freshness checks.
 *
 * Signature verification alone proves a payload was signed with the shared
 * secret — not that it was signed recently. Without a tolerance window a
 * captured delivery replays forever, so PSPs that sign a timestamp expect
 * receivers to reject stale ones.
 */

import { PaymentProviderError } from './provider.js';

/** Matches Stripe's default tolerance and the Standard Webhooks recommendation. */
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Read a tolerance override in seconds. Falls back to the default when unset
 * or unparseable; a value of `0` disables the freshness check entirely.
 */
export function webhookToleranceSeconds(envName: string): number {
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === '') return DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
  return parsed;
}

/**
 * Throw unless `timestamp` (unix seconds) is within `toleranceSeconds` of now.
 * Future-dated timestamps are rejected on the same window, so a skewed or
 * forged clock cannot buy an attacker a longer replay horizon.
 */
export function assertFreshTimestamp(params: {
  provider: string;
  timestamp: string;
  toleranceSeconds: number;
  /** Injectable clock for tests. */
  nowMs?: number;
}): void {
  const { provider, timestamp, toleranceSeconds } = params;
  if (toleranceSeconds <= 0) return;

  const seconds = Number(timestamp.trim());
  if (!Number.isFinite(seconds)) {
    throw new PaymentProviderError(
      `Invalid ${provider} webhook timestamp "${timestamp}"`,
      'INVALID_WEBHOOK',
    );
  }

  const ageSeconds = Math.abs((params.nowMs ?? Date.now()) / 1000 - seconds);
  if (ageSeconds > toleranceSeconds) {
    throw new PaymentProviderError(
      `${provider} webhook timestamp is outside the ${toleranceSeconds}s tolerance ` +
        `(off by ${Math.round(ageSeconds)}s) — possible replay`,
      'INVALID_WEBHOOK',
    );
  }
}
