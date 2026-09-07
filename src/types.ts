/**
 * Provider-agnostic SaaS billing types.
 *
 * Apps map their own plan enums onto opaque `planKey` strings.
 * `accountId` is the tenant/workspace/org id in the consuming app.
 */

export type PaymentProviderId =
  | 'stripe'
  | 'paddle'
  | 'lemon_squeezy'
  | 'polar'
  | 'chargebee';

export type BillingInvoice = {
  id: string;
  date: Date | null;
  amount: number;
  currency: string;
  status: string;
  pdfUrl: string | null;
};

export type SubscriptionInfo = {
  renewalDate: Date | null;
  status: string | null;
  providerCustomerId: string | null;
};

export type CreateCheckoutInput = {
  accountId: string;
  accountName: string;
  accountSlug?: string;
  /** Opaque plan key defined by the consuming app (e.g. "pro"). */
  planKey: string;
  customerEmail?: string | null;
  successUrl: string;
  cancelUrl: string;
};

export type CreateCheckoutResult = {
  url: string;
  providerCustomerId: string;
};

export type CreatePortalInput = {
  accountId: string;
  returnUrl: string;
};

/** Normalized billing lifecycle events — adapters map PSP webhooks into these. */
export type BillingEvent =
  | {
      type: 'subscription.activated' | 'subscription.updated';
      accountId: string;
      planKey: string;
      providerCustomerId?: string | null;
      provider: PaymentProviderId;
    }
  | {
      type: 'subscription.canceled';
      accountId: string;
      provider: PaymentProviderId;
    }
  | {
      type: 'invoice.payment_failed';
      accountId: string;
      invoiceId: string;
      provider: PaymentProviderId;
    };
