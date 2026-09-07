import type {
  BillingEvent,
  BillingInvoice,
  CreateCheckoutInput,
  CreateCheckoutResult,
  CreatePortalInput,
  PaymentProviderId,
  SubscriptionInfo,
} from './types.js';

/**
 * Payment provider port (hexagonal adapter boundary).
 * App routers / domain depend on this — never on a concrete PSP SDK.
 */
export interface PaymentProvider {
  readonly id: PaymentProviderId;

  createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult>;

  createCustomerPortal(input: CreatePortalInput): Promise<{ url: string }>;

  listInvoices(accountId: string, limit?: number): Promise<BillingInvoice[]>;

  getSubscriptionInfo(accountId: string): Promise<SubscriptionInfo>;

  /**
   * Verify webhook authenticity using provider-specific signatures/headers,
   * then return zero or more normalized billing events.
   */
  verifyAndParseWebhook(input: {
    rawBody: string | Buffer;
    headers: Headers | Record<string, string | null | undefined>;
  }): Promise<BillingEvent[]>;
}

export type PaymentProviderErrorCode =
  | 'UNAVAILABLE'
  | 'NOT_CONFIGURED'
  | 'CUSTOMER_NOT_FOUND'
  | 'CHECKOUT_URL_MISSING'
  | 'INVALID_WEBHOOK'
  | 'UNKNOWN';

export class PaymentProviderError extends Error {
  readonly code: PaymentProviderErrorCode;

  constructor(message: string, code: PaymentProviderErrorCode = 'UNKNOWN') {
    super(message);
    this.name = 'PaymentProviderError';
    this.code = code;
  }
}
