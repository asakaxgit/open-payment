/**
 * Shared planKey ↔ provider price/variant/product catalog.
 * Consuming apps configure mappings; adapters resolve IDs from here.
 */

import type { PaymentProviderId } from './types.js';

export const SUPPORTED_PAYMENT_PROVIDERS = [
  'stripe',
  'paddle',
  'lemon_squeezy',
  'polar',
  'chargebee',
] as const satisfies readonly PaymentProviderId[];

/** planKey → provider price/variant/product id */
export type PriceCatalog = Partial<
  Record<PaymentProviderId, Record<string, string>>
>;

const DEFAULT_ENV_PREFIX: Record<PaymentProviderId, string> = {
  stripe: 'STRIPE_PRICE_',
  paddle: 'PADDLE_PRICE_',
  lemon_squeezy: 'LEMON_SQUEEZY_VARIANT_',
  polar: 'POLAR_PRODUCT_',
  chargebee: 'CHARGEBEE_ITEM_PRICE_',
};

let catalogOverride: PriceCatalog | null = null;

/** Configure planKey → price id maps for each provider (preferred over env). */
export function configurePriceCatalog(catalog: PriceCatalog): void {
  catalogOverride = catalog;
}

export function getPriceCatalog(): PriceCatalog {
  return catalogOverride ?? {};
}

export function isPaymentProviderId(value: string): value is PaymentProviderId {
  return (SUPPORTED_PAYMENT_PROVIDERS as readonly string[]).includes(value);
}

function planKeyToEnvSuffix(planKey: string): string {
  return planKey.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

export function getProviderPriceId(
  provider: PaymentProviderId,
  planKey: string,
): string | undefined {
  const fromCatalog = catalogOverride?.[provider]?.[planKey];
  if (fromCatalog && fromCatalog.length > 0) return fromCatalog;

  const envName = `${DEFAULT_ENV_PREFIX[provider]}${planKeyToEnvSuffix(planKey)}`;
  const value = process.env[envName];
  return value && value.length > 0 ? value : undefined;
}

export function listConfiguredPlanKeys(provider: PaymentProviderId): string[] {
  const keys = new Set<string>();
  const mapped = catalogOverride?.[provider] ?? {};
  for (const [k, v] of Object.entries(mapped)) {
    if (v) keys.add(k);
  }
  // Also discover from env for known keys in catalog across providers
  for (const other of Object.values(catalogOverride ?? {})) {
    for (const k of Object.keys(other ?? {})) keys.add(k);
  }
  return [...keys];
}

export function resolvePlanKeyFromProviderPriceId(
  provider: PaymentProviderId,
  priceId: string | null | undefined,
): string | null {
  if (!priceId) return null;
  const mapped = catalogOverride?.[provider] ?? {};
  for (const [planKey, id] of Object.entries(mapped)) {
    if (id === priceId) return planKey;
  }
  // env scan for configured catalog keys + common attempt via reverse env is limited;
  // apps should prefer configurePriceCatalog.
  for (const planKey of listConfiguredPlanKeys(provider)) {
    if (getProviderPriceId(provider, planKey) === priceId) return planKey;
  }
  return null;
}

export function checkoutCustomData(input: {
  accountId: string;
  planKey: string;
}): Record<string, string> {
  return {
    account_id: input.accountId,
    // backward-compatible alias for older metadata writers
    workspace_id: input.accountId,
    plan: input.planKey,
  };
}

export function planKeyFromCustomData(
  data: Record<string, unknown> | null | undefined,
): string | null {
  const plan = data?.plan ?? data?.planKey;
  return typeof plan === 'string' && plan.length > 0 ? plan : null;
}

export function accountIdFromCustomData(
  data: Record<string, unknown> | null | undefined,
): string | null {
  const id =
    data?.account_id ??
    data?.accountId ??
    data?.workspace_id ??
    data?.workspaceId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** @deprecated Use accountIdFromCustomData */
export const workspaceIdFromCustomData = accountIdFromCustomData;
