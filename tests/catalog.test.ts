import { afterEach, describe, expect, it } from 'vitest';
import {
  configurePriceCatalog,
  getProviderPriceId,
  listConfiguredPlanKeys,
  resolvePlanKeyFromProviderPriceId,
} from '../src/index.js';

const ENV_KEYS = [
  'STRIPE_PRICE_PRO',
  'STRIPE_PRICE_BUSINESS',
  'STRIPE_PRICE_PRO_PLUS',
  'PADDLE_PRICE_PRO',
  'POLAR_PRODUCT_PRO',
  'LEMON_SQUEEZY_VARIANT_PRO',
  'CHARGEBEE_ITEM_PRICE_PRO',
];

describe('env-configured catalog reverse resolution', () => {
  afterEach(() => {
    configurePriceCatalog({});
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it('reverse-resolves a plan key configured only via env', () => {
    process.env.STRIPE_PRICE_PRO = 'price_pro';
    // Forward resolution already worked; reverse used to return null.
    expect(getProviderPriceId('stripe', 'pro')).toBe('price_pro');
    expect(resolvePlanKeyFromProviderPriceId('stripe', 'price_pro')).toBe('pro');
  });

  it('reverse-resolves for every provider prefix', () => {
    process.env.PADDLE_PRICE_PRO = 'pri_1';
    process.env.POLAR_PRODUCT_PRO = 'prod_1';
    process.env.LEMON_SQUEEZY_VARIANT_PRO = 'var_1';
    process.env.CHARGEBEE_ITEM_PRICE_PRO = 'item_1';
    expect(resolvePlanKeyFromProviderPriceId('paddle', 'pri_1')).toBe('pro');
    expect(resolvePlanKeyFromProviderPriceId('polar', 'prod_1')).toBe('pro');
    expect(resolvePlanKeyFromProviderPriceId('lemon_squeezy', 'var_1')).toBe('pro');
    expect(resolvePlanKeyFromProviderPriceId('chargebee', 'item_1')).toBe('pro');
  });

  it('does not cross-resolve a price id belonging to another provider', () => {
    process.env.STRIPE_PRICE_PRO = 'price_pro';
    process.env.PADDLE_PRICE_PRO = 'pri_pro';
    expect(resolvePlanKeyFromProviderPriceId('paddle', 'price_pro')).toBeNull();
    expect(resolvePlanKeyFromProviderPriceId('stripe', 'pri_pro')).toBeNull();
  });

  it('returns null for an unknown price id', () => {
    process.env.STRIPE_PRICE_PRO = 'price_pro';
    expect(resolvePlanKeyFromProviderPriceId('stripe', 'price_nope')).toBeNull();
    expect(resolvePlanKeyFromProviderPriceId('stripe', null)).toBeNull();
    expect(resolvePlanKeyFromProviderPriceId('stripe', '')).toBeNull();
  });

  it('prefers the catalog spelling over the normalized env form', () => {
    configurePriceCatalog({ stripe: { 'pro-plus': 'price_pp' } });
    process.env.STRIPE_PRICE_PRO_PLUS = 'price_pp';
    expect(resolvePlanKeyFromProviderPriceId('stripe', 'price_pp')).toBe('pro-plus');
  });

  it('recovers env-only multi-word keys in normalized form', () => {
    process.env.STRIPE_PRICE_PRO_PLUS = 'price_pp';
    expect(resolvePlanKeyFromProviderPriceId('stripe', 'price_pp')).toBe('pro_plus');
  });

  it('resolves keys registered for another provider through this provider env', () => {
    configurePriceCatalog({ paddle: { pro: 'pri_pro' } });
    process.env.STRIPE_PRICE_PRO = 'price_pro';
    expect(resolvePlanKeyFromProviderPriceId('stripe', 'price_pro')).toBe('pro');
  });

  it('ignores env vars set to an empty value', () => {
    process.env.STRIPE_PRICE_PRO = '';
    expect(listConfiguredPlanKeys('stripe')).not.toContain('pro');
    expect(resolvePlanKeyFromProviderPriceId('stripe', '')).toBeNull();
  });
});

describe('listConfiguredPlanKeys', () => {
  afterEach(() => {
    configurePriceCatalog({});
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it('unions catalog and env keys for the given provider', () => {
    configurePriceCatalog({ stripe: { pro: 'price_pro' } });
    process.env.STRIPE_PRICE_BUSINESS = 'price_biz';
    expect(listConfiguredPlanKeys('stripe').sort()).toEqual(['business', 'pro']);
  });

  it('no longer leaks plan keys from other providers', () => {
    configurePriceCatalog({
      stripe: { pro: 'price_pro' },
      paddle: { enterprise: 'pri_ent' },
    });
    expect(listConfiguredPlanKeys('stripe')).toEqual(['pro']);
    expect(listConfiguredPlanKeys('paddle')).toEqual(['enterprise']);
  });
});
