/**
 * Stripe adapter for the PaymentProvider port.
 * All Stripe SDK usage stays in this file — domain code never imports `stripe`.
 */

import Stripe from 'stripe';
import { PaymentProviderError, type PaymentProvider } from '../provider.js';
import {
  getProviderPriceId,
  resolvePlanKeyFromProviderPriceId,
} from '../catalog.js';
import type {
  BillingEvent,
  BillingInvoice,
  CreateCheckoutInput,
  CreateCheckoutResult,
  CreatePortalInput,
  SubscriptionInfo,
} from '../types.js';

/** Test override for the Stripe SDK client. */
let stripeClientOverride: Stripe | null = null;

export function setStripeClientOverride(client: Stripe | null): void {
  stripeClientOverride = client;
}

export function getPriceIdForPlan(planKey: string): string | undefined {
  return getProviderPriceId('stripe', planKey);
}

export function resolvePlanFromPriceId(priceId: string | null | undefined): string | null {
  return resolvePlanKeyFromProviderPriceId('stripe', priceId);
}

export function getStripe(): Stripe {
  if (stripeClientOverride) return stripeClientOverride;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new PaymentProviderError('STRIPE_SECRET_KEY is not set', 'NOT_CONFIGURED');
  }
  return new Stripe(key);
}

function accountIdFromMetadata(metadata: Stripe.Metadata | null | undefined): string | null {
  const id = (metadata?.account_id ?? metadata?.workspace_id) ?? metadata?.accountId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function customerIdFrom(
  value: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined,
): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if ('deleted' in value && value.deleted) return null;
  return value.id;
}

function priceIdFromSubscription(subscription: Stripe.Subscription): string | null {
  const item = subscription.items?.data?.[0];
  const price = item?.price;
  if (!price) return null;
  return typeof price === 'string' ? price : price.id;
}

async function ensureCustomerAccountMetadata(
  stripe: Stripe,
  customerId: string,
  accountId: string,
): Promise<void> {
  await stripe.customers.update(customerId, {
    metadata: { account_id: accountId },
  });
}

export async function findStripeCustomerIdForAccount(
  stripe: Stripe,
  accountId: string,
): Promise<string | null> {
  try {
    const result = await stripe.customers.search({
      query: `metadata['account_id']:'${accountId}'`,
      limit: 1,
    });
    return result.data[0]?.id ?? null;
  } catch {
    const listed = await stripe.customers.list({ limit: 100 });
    const match = listed.data.find((c) => (c.metadata?.account_id ?? c.metadata?.workspace_id) === accountId);
    return match?.id ?? null;
  }
}

function headerGet(
  headers: Headers | Record<string, string | null | undefined>,
  name: string,
): string | null {
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name);
  }
  const record = headers as Record<string, string | null | undefined>;
  return record[name] ?? record[name.toLowerCase()] ?? null;
}

/** Map a verified Stripe event into zero-or-more normalized billing events. */
export async function stripeEventToBillingEvents(
  event: Stripe.Event,
  stripe: Stripe = getStripe(),
): Promise<BillingEvent[]> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const accountId =
        session.client_reference_id ?? accountIdFromMetadata(session.metadata) ?? null;
      if (!accountId) {
        console.warn('[open-payment:stripe] checkout.session.completed missing workspace_id');
        return [];
      }

      const planFromMeta = session.metadata?.plan;
      let planKey: string = Boolean(planFromMeta ?? '') ? (planFromMeta as string) : 'free';

      if (session.mode === 'subscription' && session.subscription) {
        const subId =
          typeof session.subscription === 'string'
            ? session.subscription
            : session.subscription.id;
        const subscription = await stripe.subscriptions.retrieve(subId);
        const fromPrice = resolvePlanFromPriceId(priceIdFromSubscription(subscription));
        if (fromPrice) planKey = fromPrice;
        else if (Boolean(subscription.metadata?.plan ?? '')) {
          planKey = subscription.metadata.plan as string;
        }
      }

      const providerCustomerId = customerIdFrom(session.customer);
      if (providerCustomerId) {
        await ensureCustomerAccountMetadata(stripe, providerCustomerId, accountId);
      }

      return [
        {
          type: 'subscription.activated',
          accountId,
          planKey,
          providerCustomerId,
          provider: 'stripe',
        },
      ];
    }

    case 'customer.subscription.updated': {
      const subscription = event.data.object as Stripe.Subscription;
      const accountId =
        accountIdFromMetadata(subscription.metadata) ??
        (await (async () => {
          const customerId = customerIdFrom(subscription.customer);
          if (!customerId) return null;
          const customer = await stripe.customers.retrieve(customerId);
          if (customer.deleted) return null;
          return accountIdFromMetadata(customer.metadata);
        })());

      if (!accountId) {
        console.warn('[open-payment:stripe] subscription.updated missing workspace_id');
        return [];
      }

      if (
        subscription.status === 'unpaid' ||
        subscription.status === 'incomplete_expired' ||
        subscription.status === 'canceled'
      ) {
        return [{ type: 'subscription.canceled', accountId, provider: 'stripe' }];
      }

      const planKey: string =
        resolvePlanFromPriceId(priceIdFromSubscription(subscription)) ??
        (Boolean(subscription.metadata?.plan ?? '')
          ? (subscription.metadata.plan as string)
          : 'free');

      const providerCustomerId = customerIdFrom(subscription.customer);
      if (providerCustomerId) {
        await ensureCustomerAccountMetadata(stripe, providerCustomerId, accountId);
      }

      return [
        {
          type: 'subscription.updated',
          accountId,
          planKey,
          providerCustomerId,
          provider: 'stripe',
        },
      ];
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      const accountId =
        accountIdFromMetadata(subscription.metadata) ??
        (await (async () => {
          const customerId = customerIdFrom(subscription.customer);
          if (!customerId) return null;
          const customer = await stripe.customers.retrieve(customerId);
          if (customer.deleted) return null;
          return accountIdFromMetadata(customer.metadata);
        })());

      if (!accountId) {
        console.warn('[open-payment:stripe] subscription.deleted missing workspace_id');
        return [];
      }

      return [{ type: 'subscription.canceled', accountId, provider: 'stripe' }];
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = customerIdFrom(invoice.customer);
      let accountId = accountIdFromMetadata(invoice.metadata);

      if (!accountId && customerId) {
        const customer = await stripe.customers.retrieve(customerId);
        if (!customer.deleted) {
          accountId = accountIdFromMetadata(customer.metadata);
        }
      }

      if (!accountId) {
        console.warn('[open-payment:stripe] invoice.payment_failed missing workspace_id', {
          invoiceId: invoice.id,
        });
        return [];
      }

      return [
        {
          type: 'invoice.payment_failed',
          accountId,
          invoiceId: invoice.id,
          provider: 'stripe',
        },
      ];
    }

    default:
      return [];
  }
}

export class StripePaymentProvider implements PaymentProvider {
  readonly id = 'stripe' as const;

  async createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    const priceId = getPriceIdForPlan(input.planKey);
    if (!priceId) {
      throw new PaymentProviderError(
        `Stripe price not configured for plan ${input.planKey}`,
        'NOT_CONFIGURED',
      );
    }

    let stripe: Stripe;
    try {
      stripe = getStripe();
    } catch (err) {
      throw new PaymentProviderError(
        err instanceof Error ? err.message : 'Stripe unavailable',
        'UNAVAILABLE',
      );
    }

    let customerId = await findStripeCustomerIdForAccount(stripe, input.accountId);
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: input.customerEmail ?? undefined,
        name: input.accountName,
        metadata: { account_id: input.accountId },
      });
      customerId = customer.id;
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: input.accountId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata: {
        account_id: input.accountId,
        planKey: input.planKey,
      },
      subscription_data: {
        metadata: {
          account_id: input.accountId,
          planKey: input.planKey,
        },
      },
    });

    if (!session.url) {
      throw new PaymentProviderError('Checkout URL missing', 'CHECKOUT_URL_MISSING');
    }

    return { url: session.url, providerCustomerId: customerId };
  }

  async createCustomerPortal(input: CreatePortalInput): Promise<{ url: string }> {
    let stripe: Stripe;
    try {
      stripe = getStripe();
    } catch (err) {
      throw new PaymentProviderError(
        err instanceof Error ? err.message : 'Stripe unavailable',
        'UNAVAILABLE',
      );
    }

    const customerId = await findStripeCustomerIdForAccount(stripe, input.accountId);
    if (!customerId) {
      throw new PaymentProviderError('Stripe customer not found', 'CUSTOMER_NOT_FOUND');
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: input.returnUrl,
    });

    return { url: session.url };
  }

  async listInvoices(accountId: string, limit = 12): Promise<BillingInvoice[]> {
    let stripe: Stripe;
    try {
      stripe = getStripe();
    } catch {
      return [];
    }

    const customerId = await findStripeCustomerIdForAccount(stripe, accountId);
    if (!customerId) return [];

    const listed = await stripe.invoices.list({ customer: customerId, limit });
    return listed.data.map((invoice) => ({
      id: invoice.id,
      date: invoice.created ? new Date(invoice.created * 1000) : null,
      amount: invoice.amount_paid ?? invoice.total ?? 0,
      currency: invoice.currency ?? 'usd',
      status: invoice.status ?? 'unknown',
      pdfUrl: invoice.invoice_pdf ?? null,
    }));
  }

  async getSubscriptionInfo(accountId: string): Promise<SubscriptionInfo> {
    try {
      const stripe = getStripe();
      const providerCustomerId = await findStripeCustomerIdForAccount(stripe, accountId);
      if (!providerCustomerId) {
        return { renewalDate: null, status: null, providerCustomerId: null };
      }

      const subscriptions = await stripe.subscriptions.list({
        customer: providerCustomerId,
        status: 'all',
        limit: 1,
      });
      const active = subscriptions.data.find(
        (s) => s.status === 'active' || s.status === 'trialing' || s.status === 'past_due',
      );
      const periodEnd = active?.items?.data?.[0]?.current_period_end;

      return {
        renewalDate: periodEnd ? new Date(periodEnd * 1000) : null,
        status: active?.status ?? null,
        providerCustomerId,
      };
    } catch {
      return { renewalDate: null, status: null, providerCustomerId: null };
    }
  }

  async verifyAndParseWebhook(input: {
    rawBody: string | Buffer;
    headers: Headers | Record<string, string | null | undefined>;
  }): Promise<BillingEvent[]> {
    const signature = headerGet(input.headers, 'stripe-signature');
    if (!signature) {
      throw new PaymentProviderError('Missing stripe-signature', 'INVALID_WEBHOOK');
    }

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      throw new PaymentProviderError('STRIPE_WEBHOOK_SECRET is not set', 'NOT_CONFIGURED');
    }

    let event: Stripe.Event;
    try {
      event = getStripe().webhooks.constructEvent(input.rawBody, signature, webhookSecret);
    } catch (err) {
      throw new PaymentProviderError(
        err instanceof Error ? err.message : 'Invalid Stripe webhook signature',
        'INVALID_WEBHOOK',
      );
    }

    return stripeEventToBillingEvents(event);
  }
}

export function createStripePaymentProvider(): PaymentProvider {
  return new StripePaymentProvider();
}
