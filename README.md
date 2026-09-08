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

# Webhook replay tolerance in seconds (default 300, 0 disables the check)
PADDLE_WEBHOOK_TOLERANCE_SECONDS=
POLAR_WEBHOOK_TOLERANCE_SECONDS=
```

## Webhook replay protection

Signature verification proves a payload was signed with your secret, not that
it was signed recently. Adapters whose PSP signs a timestamp reject deliveries
outside a 300s tolerance window (Stripe enforces this internally; Paddle and
Polar are checked by this package).

**Lemon Squeezy is the exception:** its `X-Signature` is a bare HMAC of the
request body with no timestamp, so a captured delivery stays valid
indefinitely. If you use that adapter, deduplicate on the event id in your own
handler — the library is stateless and cannot do it for you.

Plan ↔ price IDs are configured via `configurePriceCatalog()` (preferred) or
env vars of the form `{PROVIDER}_PRICE_{PLAN_KEY}` / provider-specific prefixes.
Both directions work with either method: webhook parsing maps a provider price
id back to your plan key.

Env-derived keys are normalized, since the env name uppercases the key and
collapses non-alphanumerics — a plan key of `pro-plus` becomes
`STRIPE_PRICE_PRO_PLUS` and reverse-resolves as `pro_plus`. Use
`configurePriceCatalog()` when you need your exact key spelling back.

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
