import { afterEach, describe, expect, it } from 'vitest';
import { paddlePayloadToBillingEvents } from '../src/adapters/paddle.js';
import { lemonSqueezyPayloadToBillingEvents } from '../src/adapters/lemon-squeezy.js';
import { polarPayloadToBillingEvents } from '../src/adapters/polar.js';
import { chargebeePayloadToBillingEvents } from '../src/adapters/chargebee.js';
import { stripeEventToBillingEvents } from '../src/adapters/stripe.js';
import { getPaymentProvider, setPaymentProviderOverride } from '../src/index.js';
import {
  FIXTURE_ACCOUNT_ID,
  FIXTURE_CUSTOMER_ID,
  FIXTURE_PLAN_KEY,
  PROVIDER_WEBHOOK_FIXTURES,
  createMockPaymentProvider,
  fixtureActivated,
  stripeCheckoutSessionCompletedObject,
  type ProviderWebhookFixture,
} from '../src/testing/index.js';

const MAPPERS: Record<
  Exclude<ProviderWebhookFixture['provider'], 'stripe'>,
  (payload: unknown) => ReturnType<typeof paddlePayloadToBillingEvents>
> = {
  paddle: paddlePayloadToBillingEvents,
  lemon_squeezy: lemonSqueezyPayloadToBillingEvents,
  polar: polarPayloadToBillingEvents,
  chargebee: chargebeePayloadToBillingEvents,
};

describe('per-SaaS webhook fixtures → BillingEvents', () => {
  for (const fixture of PROVIDER_WEBHOOK_FIXTURES) {
    it(`${fixture.provider}: ${fixture.description}`, () => {
      const map = MAPPERS[fixture.provider as keyof typeof MAPPERS];
      expect(map).toBeTypeOf('function');
      expect(map(fixture.payload)).toEqual(fixture.expectedEvents);
    });
  }

  it('stripe: checkout.session.completed from fixture object', async () => {
    const event = {
      id: 'evt_test_1',
      object: 'event',
      type: 'checkout.session.completed',
      data: { object: stripeCheckoutSessionCompletedObject },
    } as Parameters<typeof stripeEventToBillingEvents>[0];

    // Pass a stub Stripe client — default arg calls getStripe() even when unused.
    const stripeStub = {} as Parameters<typeof stripeEventToBillingEvents>[1];
    await expect(stripeEventToBillingEvents(event, stripeStub)).resolves.toEqual([
      {
        ...fixtureActivated('stripe'),
        providerCustomerId: null,
      },
    ]);
  });
});

describe('createMockPaymentProvider', () => {
  afterEach(() => {
    setPaymentProviderOverride(null);
  });

  it.each([
    'stripe',
    'paddle',
    'lemon_squeezy',
    'polar',
    'chargebee',
  ] as const)('mocks %s without network I/O', async (id) => {
    const mock = createMockPaymentProvider({
      id,
      webhookEvents: [fixtureActivated(id)],
    });
    setPaymentProviderOverride(mock);

    const provider = getPaymentProvider();
    expect(provider.id).toBe(id);

    const checkout = await provider.createCheckout({
      accountId: FIXTURE_ACCOUNT_ID,
      accountName: 'Test',
      planKey: FIXTURE_PLAN_KEY,
      successUrl: 'https://app.test/ok',
      cancelUrl: 'https://app.test/cancel',
    });
    expect(checkout.url).toContain(FIXTURE_PLAN_KEY);
    expect(checkout.providerCustomerId).toBe(`cus_mock_${FIXTURE_ACCOUNT_ID}`);

    const portal = await provider.createCustomerPortal({
      accountId: FIXTURE_ACCOUNT_ID,
      returnUrl: 'https://app.test/billing',
    });
    expect(portal.url).toContain(FIXTURE_ACCOUNT_ID);

    await expect(provider.listInvoices(FIXTURE_ACCOUNT_ID, 5)).resolves.toEqual([]);

    const sub = await provider.getSubscriptionInfo(FIXTURE_ACCOUNT_ID);
    expect(sub.providerCustomerId).toBe(`cus_mock_${FIXTURE_ACCOUNT_ID}`);

    const events = await provider.verifyAndParseWebhook({
      rawBody: '{}',
      headers: {},
    });
    expect(events).toEqual([fixtureActivated(id)]);

    expect(mock.calls.createCheckout).toHaveLength(1);
    expect(mock.calls.verifyAndParseWebhook).toHaveLength(1);
    expect(mock.calls.getSubscriptionInfo[0]).toBe(FIXTURE_ACCOUNT_ID);
  });

  it('records and resets calls', async () => {
    const mock = createMockPaymentProvider({
      checkout: {
        url: 'https://pay.test/session',
        providerCustomerId: FIXTURE_CUSTOMER_ID,
      },
    });
    await mock.createCheckout({
      accountId: FIXTURE_ACCOUNT_ID,
      accountName: 'Test',
      planKey: FIXTURE_PLAN_KEY,
      successUrl: 'https://ok',
      cancelUrl: 'https://cancel',
    });
    expect(mock.calls.createCheckout).toHaveLength(1);
    mock.reset();
    expect(mock.calls.createCheckout).toHaveLength(0);
  });
});
