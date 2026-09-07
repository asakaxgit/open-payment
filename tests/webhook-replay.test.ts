import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyPaddleSignature } from '../src/adapters/paddle.js';
import { verifyPolarSignature } from '../src/adapters/polar.js';
import { DEFAULT_WEBHOOK_TOLERANCE_SECONDS, webhookToleranceSeconds } from '../src/webhook.js';

const NOW_MS = 1_760_000_000_000;
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const BODY = '{"event_type":"subscription.created"}';

describe('paddle webhook replay protection', () => {
  afterEach(() => {
    delete process.env.PADDLE_WEBHOOK_SECRET;
    delete process.env.PADDLE_WEBHOOK_TOLERANCE_SECONDS;
  });

  function signedHeader(timestampSeconds: number, secret = 'pdl-secret'): string {
    const h1 = createHmac('sha256', secret)
      .update(`${timestampSeconds}:${BODY}`)
      .digest('hex');
    return `ts=${timestampSeconds};h1=${h1}`;
  }

  it('accepts a freshly signed delivery', () => {
    process.env.PADDLE_WEBHOOK_SECRET = 'pdl-secret';
    expect(() =>
      verifyPaddleSignature(BODY, signedHeader(NOW_SECONDS - 5), NOW_MS),
    ).not.toThrow();
  });

  it('rejects a valid signature replayed after the tolerance window', () => {
    process.env.PADDLE_WEBHOOK_SECRET = 'pdl-secret';
    const captured = signedHeader(NOW_SECONDS - 3600);
    // The HMAC is still genuine — only freshness rejects it.
    expect(() => verifyPaddleSignature(BODY, captured, NOW_MS)).toThrow(/possible replay/);
  });

  it('rejects future-dated timestamps on the same window', () => {
    process.env.PADDLE_WEBHOOK_SECRET = 'pdl-secret';
    expect(() =>
      verifyPaddleSignature(BODY, signedHeader(NOW_SECONDS + 3600), NOW_MS),
    ).toThrow(/possible replay/);
  });

  it('still rejects a bad signature before checking freshness', () => {
    process.env.PADDLE_WEBHOOK_SECRET = 'pdl-secret';
    const forged = signedHeader(NOW_SECONDS, 'wrong-secret');
    expect(() => verifyPaddleSignature(BODY, forged, NOW_MS)).toThrow(
      /Invalid Paddle webhook signature/,
    );
  });

  it('honours a configured tolerance override', () => {
    process.env.PADDLE_WEBHOOK_SECRET = 'pdl-secret';
    process.env.PADDLE_WEBHOOK_TOLERANCE_SECONDS = '7200';
    expect(() =>
      verifyPaddleSignature(BODY, signedHeader(NOW_SECONDS - 3600), NOW_MS),
    ).not.toThrow();
  });

  it('treats a zero tolerance as an opt-out', () => {
    process.env.PADDLE_WEBHOOK_SECRET = 'pdl-secret';
    process.env.PADDLE_WEBHOOK_TOLERANCE_SECONDS = '0';
    expect(() =>
      verifyPaddleSignature(BODY, signedHeader(NOW_SECONDS - 86_400), NOW_MS),
    ).not.toThrow();
  });
});

describe('polar webhook replay protection', () => {
  afterEach(() => {
    delete process.env.POLAR_WEBHOOK_SECRET;
    delete process.env.POLAR_WEBHOOK_TOLERANCE_SECONDS;
  });

  function signedHeaders(
    timestampSeconds: number,
    secret = 'polar-secret',
  ): Record<string, string> {
    const msgId = 'msg_123';
    const signature = createHmac('sha256', secret)
      .update(`${msgId}.${timestampSeconds}.${BODY}`)
      .digest('base64');
    return {
      'webhook-id': msgId,
      'webhook-timestamp': String(timestampSeconds),
      'webhook-signature': `v1,${signature}`,
    };
  }

  it('accepts a freshly signed delivery', () => {
    process.env.POLAR_WEBHOOK_SECRET = 'polar-secret';
    expect(() =>
      verifyPolarSignature(BODY, signedHeaders(NOW_SECONDS - 5), NOW_MS),
    ).not.toThrow();
  });

  it('rejects a valid signature replayed after the tolerance window', () => {
    process.env.POLAR_WEBHOOK_SECRET = 'polar-secret';
    expect(() =>
      verifyPolarSignature(BODY, signedHeaders(NOW_SECONDS - 3600), NOW_MS),
    ).toThrow(/possible replay/);
  });

  it('rejects future-dated timestamps on the same window', () => {
    process.env.POLAR_WEBHOOK_SECRET = 'polar-secret';
    expect(() =>
      verifyPolarSignature(BODY, signedHeaders(NOW_SECONDS + 3600), NOW_MS),
    ).toThrow(/possible replay/);
  });

  it('still rejects a bad signature before checking freshness', () => {
    process.env.POLAR_WEBHOOK_SECRET = 'polar-secret';
    expect(() =>
      verifyPolarSignature(BODY, signedHeaders(NOW_SECONDS, 'wrong-secret'), NOW_MS),
    ).toThrow(/Invalid Polar webhook signature/);
  });

  it('rejects a non-numeric timestamp', () => {
    process.env.POLAR_WEBHOOK_SECRET = 'polar-secret';
    const headers = signedHeaders(NOW_SECONDS);
    const msgId = headers['webhook-id'];
    const signature = createHmac('sha256', 'polar-secret')
      .update(`${msgId}.not-a-number.${BODY}`)
      .digest('base64');
    expect(() =>
      verifyPolarSignature(
        BODY,
        {
          'webhook-id': msgId,
          'webhook-timestamp': 'not-a-number',
          'webhook-signature': `v1,${signature}`,
        },
        NOW_MS,
      ),
    ).toThrow(/Invalid Polar webhook timestamp/);
  });
});

describe('webhookToleranceSeconds', () => {
  afterEach(() => {
    delete process.env.TEST_TOLERANCE;
  });

  it('defaults when unset, blank, negative or unparseable', () => {
    expect(webhookToleranceSeconds('TEST_TOLERANCE')).toBe(DEFAULT_WEBHOOK_TOLERANCE_SECONDS);
    for (const value of ['', '   ', '-1', 'soon']) {
      process.env.TEST_TOLERANCE = value;
      expect(webhookToleranceSeconds('TEST_TOLERANCE')).toBe(DEFAULT_WEBHOOK_TOLERANCE_SECONDS);
    }
  });

  it('reads a valid override', () => {
    process.env.TEST_TOLERANCE = '60';
    expect(webhookToleranceSeconds('TEST_TOLERANCE')).toBe(60);
  });
});
