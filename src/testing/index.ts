/**
 * Test utilities for open-payment-adapter.
 * Import from `open-payment-adapter/testing` in app/unit tests.
 */

export {
  createMockPaymentProvider,
  type MockPaymentProvider,
  type MockPaymentProviderOptions,
} from './mock-provider.js';

export {
  FIXTURE_ACCOUNT_ID,
  FIXTURE_CUSTOMER_ID,
  FIXTURE_INVOICE_ID,
  FIXTURE_PLAN_KEY,
  PROVIDER_WEBHOOK_FIXTURES,
  chargebeeSubscriptionCancelledFixture,
  chargebeeSubscriptionCreatedFixture,
  fixtureActivated,
  fixtureCanceled,
  fixturePaymentFailed,
  lemonSqueezySubscriptionCancelledFixture,
  lemonSqueezySubscriptionCreatedFixture,
  paddleSubscriptionActivatedFixture,
  paddleSubscriptionCanceledFixture,
  polarSubscriptionCanceledFixture,
  polarSubscriptionCreatedFixture,
  stripeCheckoutSessionCompletedObject,
  type ProviderWebhookFixture,
} from './fixtures.js';
