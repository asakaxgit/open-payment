# open-payment

Provider-agnostic **SaaS billing** payment port with multi-PSP adapters.

There is no widely adopted open standard for subscription orchestration
(Checkout / Customer Portal / signed webhooks / plan mapping). This package owns
a hexagonal `PaymentProvider` port and normalizes PSP webhooks into domain events.

## Install

```bash
npm install open-payment
# Stripe adapter peer (optional until you use stripe):
npm install stripe
```

## Quick start

```ts
import { getPaymentProvider, configurePriceCatalog } from 'open-payment';

configurePriceCatalog({
  stripe: { pro: 'price_xxx', business: 'price_yyy' },
  paddle: { pro: 'pri_xxx' },
});

const payments = getPaymentProvider(); // PAYMENT_PROVIDER, default stripe

const { url } = await payments.createCheckout({
  accountId: 'acct_1',
  accountName: 'Acme',
  planKey: 'pro',
  successUrl: 'https://app.example.com/billing/success',
  cancelUrl: 'https://app.example.com/billing/cancel',
});

// Webhook
const events = await payments.verifyAndParseWebhook({
  rawBody,
  headers: request.headers,
});
```

## Env

```bash
PAYMENT_PROVIDER=stripe   # stripe | paddle | lemon_squeezy | polar | chargebee

# Stripe
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

# Paddle / Lemon Squeezy / Polar / Chargebee — see adapters
```

Plan ↔ price IDs are configured via `configurePriceCatalog()` (preferred) or
env vars of the form `{PROVIDER}_PRICE_{PLAN_KEY}` / provider-specific prefixes.

## Supported providers (v0.1)

| Id | Adapter |
|---|---|
| `stripe` | Stripe Checkout / Portal / webhooks |
| `paddle` | Paddle Billing |
| `lemon_squeezy` | Lemon Squeezy |
| `polar` | Polar |
| `chargebee` | Chargebee |

## What stays in your app

- Persisting plan changes from `BillingEvent`s
- Product-specific plan enums / limits
- Email copy for payment-failed

## License

MIT
