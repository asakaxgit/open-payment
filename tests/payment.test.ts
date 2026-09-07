import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SUPPORTED_PAYMENT_PROVIDERS,
  configurePriceCatalog,
  getPaymentProvider,
  getProviderPriceId,
  isPaymentProviderId,
  listPaymentProviders,
  resolvePlanKeyFromProviderPriceId,
  setPaymentProviderOverride,
  type PaymentProvider,
} from '../src/index.js';

describe('open-payment registry', () => {
  afterEach(() => {
    setPaymentProviderOverride(null);
    configurePriceCatalog({});
    delete process.env.PAYMENT_PROVIDER;
  });

  it('lists major SaaS billing providers', () => {
    expect(listPaymentProviders()).toEqual([
      'stripe',
      'paddle',
      'lemon_squeezy',
      'polar',
      'chargebee',
    ]);
    expect(SUPPORTED_PAYMENT_PROVIDERS).toEqual(listPaymentProviders());
    expect(isPaymentProviderId('stripe')).toBe(true);
    expect(isPaymentProviderId('paypal')).toBe(false);
  });

  it('constructs an adapter for each provider id', () => {
    for (const id of listPaymentProviders()) {
      expect(getPaymentProvider(id).id).toBe(id);
    }
  });

  it('rejects unknown PAYMENT_PROVIDER', () => {
    process.env.PAYMENT_PROVIDER = 'not-a-psp';
    expect(() => getPaymentProvider()).toThrow(/Unsupported PAYMENT_PROVIDER/);
  });

  it('resolves price ids from configurePriceCatalog', () => {
    configurePriceCatalog({
      stripe: { pro: 'price_pro', business: 'price_biz' },
    });
    expect(getProviderPriceId('stripe', 'pro')).toBe('price_pro');
    expect(resolvePlanKeyFromProviderPriceId('stripe', 'price_biz')).toBe('business');
  });

  it('accepts overrides', () => {
    const fake: PaymentProvider = {
      id: 'stripe',
      createCheckout: vi.fn(),
      createCustomerPortal: vi.fn(),
      listInvoices: vi.fn(),
      getSubscriptionInfo: vi.fn(),
      verifyAndParseWebhook: vi.fn(),
    };
    setPaymentProviderOverride(fake);
    expect(getPaymentProvider()).toBe(fake);
  });
});
