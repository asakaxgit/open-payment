/**
 * In-memory mock PaymentProvider for unit/integration tests.
 * Records calls and returns configurable canned responses — no SaaS network I/O.
 */

import type { PaymentProvider } from '../provider.js';
import type {
  BillingEvent,
  BillingInvoice,
  CreateCheckoutInput,
  CreateCheckoutResult,
  CreatePortalInput,
  PaymentProviderId,
  SubscriptionInfo,
} from '../types.js';

export type MockPaymentProviderOptions = {
  id?: PaymentProviderId;
  checkout?: CreateCheckoutResult | ((input: CreateCheckoutInput) => CreateCheckoutResult);
  portalUrl?: string | ((input: CreatePortalInput) => string);
  invoices?: BillingInvoice[] | ((accountId: string, limit?: number) => BillingInvoice[]);
  subscription?: SubscriptionInfo | ((accountId: string) => SubscriptionInfo);
  webhookEvents?:
    | BillingEvent[]
    | ((input: {
        rawBody: string | Buffer;
        headers: Headers | Record<string, string | null | undefined>;
      }) => BillingEvent[]);
};

export type MockPaymentProvider = PaymentProvider & {
  readonly calls: {
    createCheckout: CreateCheckoutInput[];
    createCustomerPortal: CreatePortalInput[];
    listInvoices: Array<{ accountId: string; limit?: number }>;
    getSubscriptionInfo: string[];
    verifyAndParseWebhook: Array<{
      rawBody: string | Buffer;
      headers: Headers | Record<string, string | null | undefined>;
    }>;
  };
  reset(): void;
};

/**
 * Create a mock PaymentProvider for any supported SaaS id.
 * Use with `setPaymentProviderOverride()` or inject directly in tests.
 */
export function createMockPaymentProvider(
  options: MockPaymentProviderOptions = {},
): MockPaymentProvider {
  const calls: MockPaymentProvider['calls'] = {
    createCheckout: [],
    createCustomerPortal: [],
    listInvoices: [],
    getSubscriptionInfo: [],
    verifyAndParseWebhook: [],
  };

  const provider: MockPaymentProvider = {
    id: options.id ?? 'stripe',
    calls,
    reset() {
      calls.createCheckout.length = 0;
      calls.createCustomerPortal.length = 0;
      calls.listInvoices.length = 0;
      calls.getSubscriptionInfo.length = 0;
      calls.verifyAndParseWebhook.length = 0;
    },
    async createCheckout(input) {
      calls.createCheckout.push(input);
      if (typeof options.checkout === 'function') return options.checkout(input);
      return (
        options.checkout ?? {
          url: `https://checkout.example.test/${input.planKey}`,
          providerCustomerId: `cus_mock_${input.accountId}`,
        }
      );
    },
    async createCustomerPortal(input) {
      calls.createCustomerPortal.push(input);
      const url =
        typeof options.portalUrl === 'function'
          ? options.portalUrl(input)
          : (options.portalUrl ?? `https://portal.example.test/${input.accountId}`);
      return { url };
    },
    async listInvoices(accountId, limit) {
      calls.listInvoices.push({ accountId, limit });
      if (typeof options.invoices === 'function') return options.invoices(accountId, limit);
      return options.invoices ?? [];
    },
    async getSubscriptionInfo(accountId) {
      calls.getSubscriptionInfo.push(accountId);
      if (typeof options.subscription === 'function') return options.subscription(accountId);
      return (
        options.subscription ?? {
          renewalDate: null,
          status: 'active',
          providerCustomerId: `cus_mock_${accountId}`,
        }
      );
    },
    async verifyAndParseWebhook(input) {
      calls.verifyAndParseWebhook.push(input);
      if (typeof options.webhookEvents === 'function') return options.webhookEvents(input);
      return options.webhookEvents ?? [];
    },
  };

  return provider;
}
