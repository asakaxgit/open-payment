import { createChargebeePaymentProvider } from './adapters/chargebee.js';
import { createLemonSqueezyPaymentProvider } from './adapters/lemon-squeezy.js';
import { createPaddlePaymentProvider } from './adapters/paddle.js';
import { createPolarPaymentProvider } from './adapters/polar.js';
import { createStripePaymentProvider } from './adapters/stripe.js';
import {
  SUPPORTED_PAYMENT_PROVIDERS,
  configurePriceCatalog,
  getPriceCatalog,
  getProviderPriceId,
  isPaymentProviderId,
} from './catalog.js';
import { PaymentProviderError, type PaymentProvider } from './provider.js';
import type { PaymentProviderId } from './types.js';

export type { PaymentProvider } from './provider.js';
export { PaymentProviderError } from './provider.js';
export type {
  BillingEvent,
  BillingInvoice,
  CreateCheckoutInput,
  CreateCheckoutResult,
  CreatePortalInput,
  PaymentProviderId,
  SubscriptionInfo,
} from './types.js';
export {
  SUPPORTED_PAYMENT_PROVIDERS,
  accountIdFromCustomData,
  checkoutCustomData,
  configurePriceCatalog,
  getPriceCatalog,
  getProviderPriceId,
  isPaymentProviderId,
  listConfiguredPlanKeys,
  planKeyFromCustomData,
  resolvePlanKeyFromProviderPriceId,
  workspaceIdFromCustomData,
} from './catalog.js';
export {
  createStripePaymentProvider,
  setStripeClientOverride,
  getStripe,
} from './adapters/stripe.js';
export { createPaddlePaymentProvider } from './adapters/paddle.js';
export { createLemonSqueezyPaymentProvider } from './adapters/lemon-squeezy.js';
export { createPolarPaymentProvider } from './adapters/polar.js';
export { createChargebeePaymentProvider } from './adapters/chargebee.js';

let providerOverride: PaymentProvider | null = null;

/** Test helper — inject a fake provider. */
export function setPaymentProviderOverride(provider: PaymentProvider | null): void {
  providerOverride = provider;
}

function resolveProviderId(explicit?: PaymentProviderId): PaymentProviderId {
  if (explicit) {
    if (!isPaymentProviderId(explicit)) {
      throw new PaymentProviderError(
        `Unsupported payment provider "${explicit}"`,
        'NOT_CONFIGURED',
      );
    }
    return explicit;
  }
  const fromEnv = (process.env.PAYMENT_PROVIDER ?? 'stripe').toLowerCase();
  if (!isPaymentProviderId(fromEnv)) {
    throw new PaymentProviderError(
      `Unsupported PAYMENT_PROVIDER="${fromEnv}". Supported: ${SUPPORTED_PAYMENT_PROVIDERS.join(', ')}`,
      'NOT_CONFIGURED',
    );
  }
  return fromEnv;
}

function createProvider(id: PaymentProviderId): PaymentProvider {
  switch (id) {
    case 'stripe':
      return createStripePaymentProvider();
    case 'paddle':
      return createPaddlePaymentProvider();
    case 'lemon_squeezy':
      return createLemonSqueezyPaymentProvider();
    case 'polar':
      return createPolarPaymentProvider();
    case 'chargebee':
      return createChargebeePaymentProvider();
    default: {
      const _exhaustive: never = id;
      throw new PaymentProviderError(
        `Unknown payment provider: ${String(_exhaustive)}`,
        'NOT_CONFIGURED',
      );
    }
  }
}

/**
 * Resolve the active payment provider.
 * Set `PAYMENT_PROVIDER` to one of: stripe | paddle | lemon_squeezy | polar | chargebee.
 */
export function getPaymentProvider(id?: PaymentProviderId): PaymentProvider {
  if (providerOverride) return providerOverride;
  return createProvider(resolveProviderId(id));
}

export function listPaymentProviders(): readonly PaymentProviderId[] {
  return SUPPORTED_PAYMENT_PROVIDERS;
}
