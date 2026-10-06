/**
 * @fileoverview Mock KYC transitions, checks, wallets, and tier rules.
 */

import {describe, expect, test} from 'bun:test';
import {AgentStore} from '../../db/src/index';
import {KYC_FIXTURE_CASES} from '../src/fixtures/kyc-demo';
import {
  KYC_BADGES,
  KYC_CHECK,
  KYC_TIER_RULES,
  KycFlowError,
  MockKycProvider,
  countsAsVerified,
  tierForSubmittedChecks,
  type KycResult,
  type KycScript,
  type KycTierRules,
  type KycView,
} from '../src/kyc';
import type {Entity} from '../src/types';

const T0 = '2026-10-06T00:00:00.000Z';
const T1 = '2026-10-06T00:01:00.000Z';
const T2 = '2026-10-06T00:02:00.000Z';
const T3 = '2026-10-06T00:03:00.000Z';
const T4 = '2026-10-06T00:04:00.000Z';
const T5 = '2026-10-06T00:05:00.000Z';

const ENTITY: Entity = {
  id: 'entity-established',
  displayName: 'Meridian Services',
  wallets: ['addr_test1meridian00000000000000000000000001'],
  kycStatus: 'verified',
  kycTier: 'enhanced',
  roles: ['buyer', 'seller'],
  createdAt: '2026-06-01T00:00:00.000Z',
};

function expectCode(run: () => void, code: KycFlowError['code']): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(KycFlowError);
    if (error instanceof KycFlowError) {
      expect(error.code).toBe(code);
      return;
    }
  }
  throw new Error(`expected ${code}`);
}

function withKyc(
  run: (provider: MockKycProvider, store: AgentStore) => void,
  options: {
    rules?: KycTierRules;
    scripts?: readonly KycScript[];
    overrides?: ReadonlyMap<string, KycResult>;
  } = {},
): void {
  const store = AgentStore.open();
  try {
    const provider = new MockKycProvider(options.overrides ?? new Map(), {
      store,
      rules: options.rules,
      scripts: options.scripts,
    });
    run(provider, store);
  } finally {
    store.close();
  }
}

function person(
  provider: MockKycProvider,
  id: string,
  documentId: string|undefined,
  at = T0,
): KycView {
  return provider.registerEntity({
    id,
    displayName: id,
    roles: ['buyer'],
    wallets: [`wallet-${id}`],
    kind: 'person',
    documentId,
    at,
  });
}

describe('MockKycProvider', () => {
  test('returns the mapped status for a known entity', () => {
    const provider = new MockKycProvider(new Map([[
      ENTITY.id,
      {
        status: 'verified', tier: 'enhanced', provider: 'mock',
        checkedAt: T0,
      },
    ]]));
    const result = provider.fetchStatus(ENTITY, T0);
    expect(result.status).toBe('verified');
    expect(result.tier).toBe('enhanced');
    expect(result.provider).toBe(provider.name);
    expect(result.checkedAt).toBe(T0);
  });

  test('falls back to unverified for an unknown entity', () => {
    const provider = new MockKycProvider();
    const result = provider.fetchStatus({...ENTITY, id: 'entity-unknown'}, T0);
    expect(result.status).toBe('unverified');
    expect(result.tier).toBe('none');
  });

  test('keeps the override ahead of the stored row', () => {
    withKyc((provider, store) => {
      const view = person(provider, 'override', 'DOC-100');
      provider.submitCheck({
        kind: 'person', entityId: view.entity.id, documentId: 'DOC-100', at: T1,
      });
      const resolved = provider.resolveCheck(view.entity.id, T2);
      expect(store.getEntity('override')?.kycStatus).toBe('verified');
      const fetched = provider.fetchStatus(resolved.entity, T3);
      expect(fetched.status).toBe('rejected');
      expect(fetched.tier).toBe('none');
      expect(fetched.provider).toBe(provider.name);
      // The view and the policy input read the same status as fetchStatus.
      expect(resolved.status).toBe('rejected');
      expect(resolved.badge).toBe('rejected');
      expect(resolved.policyInput.kycStatus).toBe('rejected');
      expect(resolved.policyInput.countsAsVerified).toBe(false);
    }, {
      overrides: new Map([[
        'override',
        {
          status: 'rejected', tier: 'none', provider: 'other', checkedAt: T0,
        },
      ]]),
    });
  });

  test('requires a store for onboarding', () => {
    const provider = new MockKycProvider();
    expectCode(() => person(provider, 'none', 'DOC-1'), 'store_required');
  });
});

describe('KYC registration', () => {
  test('registers a buyer, a seller, or both and attaches wallets', () => {
    withKyc((provider, store) => {
      const buyer = provider.registerEntity({
        id: 'buyer',
        displayName: 'Buyer',
        roles: ['buyer'],
        wallets: ['wallet-z', 'wallet-a', 'wallet-a'],
        kind: 'person',
        at: T0,
      });
      expect(buyer.entity.roles).toEqual(['buyer']);
      expect(buyer.entity.wallets).toEqual(['wallet-a', 'wallet-z']);
      expect(buyer.status).toBe('unverified');
      expect(buyer.tier).toBe('none');
      expect(buyer.badge).toBe('unverified');
      expect(buyer.history.map((row) => row.how)).toEqual(['registered']);
      expect(buyer.history[0]?.at).toBe(T0);
      expect(buyer.history[0]?.provider).toBe(provider.name);

      const seller = provider.registerEntity({
        id: 'seller',
        displayName: 'Seller',
        roles: ['seller'],
        wallets: ['wallet-seller'],
        kind: 'business',
        registrationNumber: 'REG-100',
        at: T0,
      });
      expect(seller.entity.roles).toEqual(['seller']);
      expect(seller.subjectKind).toBe('business');

      const both = provider.registerEntity({
        id: 'both',
        displayName: 'Both',
        roles: ['both'],
        wallets: ['wallet-both'],
        kind: 'person',
        at: T0,
      });
      expect(both.entity.roles).toEqual(['buyer', 'seller']);
      const ordered = provider.registerEntity({
        id: 'ordered',
        displayName: 'Ordered',
        roles: ['seller', 'buyer'],
        wallets: ['wallet-ordered'],
        kind: 'person',
        at: T0,
      });
      expect(ordered.entity.roles).toEqual(['seller', 'buyer']);

      const attached = provider.attachWallet('buyer', 'wallet-m', T1);
      expect(attached.entity.wallets).toEqual([
        'wallet-a', 'wallet-m', 'wallet-z',
      ]);
      expect(attached.status).toBe('unverified');
      expect(attached.history).toHaveLength(1);
      const again = provider.attachWallet('buyer', 'wallet-m', T2);
      expect(again.entity.wallets).toEqual(attached.entity.wallets);
      expect(store.getReliabilityState('buyer', 'payment', 'buyer')).toBeUndefined();

      expectCode(
        () => provider.attachWallet('buyer', 'wallet-seller', T2),
        'wallet_in_use',
      );
      expectCode(
        () => provider.registerEntity({
          id: 'buyer',
          displayName: 'Buyer',
          roles: ['buyer'],
          wallets: ['wallet-new'],
          kind: 'person',
          at: T0,
        }),
        'entity_exists',
      );
      expectCode(
        () => provider.registerEntity({
          id: 'empty-role',
          displayName: 'Empty',
          roles: [],
          wallets: ['wallet-empty-role'],
          kind: 'person',
          at: T0,
        }),
        'roles_required',
      );
      expectCode(
        () => provider.registerEntity({
          id: 'bad-role',
          displayName: 'Bad',
          roles: ['auditor'],
          wallets: ['wallet-bad-role'],
          kind: 'person',
          at: T0,
        }),
        'unknown_role',
      );
      expectCode(
        () => provider.registerEntity({
          id: 'no-wallet',
          displayName: 'No wallet',
          roles: ['buyer'],
          wallets: [],
          kind: 'person',
          at: T0,
        }),
        'wallet_required',
      );
    });
  });
});

describe('person and business KYC paths', () => {
  test('moves a person through each status and both tiers', () => {
    withKyc((provider) => {
      const registered = person(provider, 'ada', 'DOC-100');
      expect(registered.policyInput).toEqual({
        entityId: 'ada',
        kycStatus: 'unverified',
        kycTier: 'none',
        badge: 'unverified',
        countsAsVerified: false,
        reRegistrationOf: null,
        reRegistrationSignal: null,
        rulesVersion: KYC_TIER_RULES.version,
      });
      expectCode(() => provider.resolveCheck('ada', T1), 'not_pending');
      expectCode(() => provider.expireVerification('ada', T1), 'not_verified');

      const pending = provider.submitCheck({
        kind: 'person', entityId: 'ada', documentId: 'DOC-100', at: T1,
      });
      expect(pending.status).toBe('pending');
      expect(pending.tier).toBe('none');
      expect(pending.badge).toBe('pending');
      expect(pending.submittedChecks).toEqual([KYC_CHECK.personIdentity]);
      expect(pending.countsAsVerified).toBe(false);

      const basic = provider.resolveCheck('ada', T2);
      expect(basic.status).toBe('verified');
      expect(basic.tier).toBe('basic');
      expect(basic.badge).toBe('verified');
      expect(basic.countsAsVerified).toBe(true);
      expect(basic.verifiedAt).toBe(T2);
      expect(basic.history.map((row) => row.how)).toEqual([
        'registered', 'check_submitted', 'vendor_approved',
      ]);
      expect(provider.fetchStatus(basic.entity, T2).tier).toBe('basic');

      const reviewing = provider.submitCheck({
        kind: 'person',
        entityId: 'ada',
        documentId: 'DOC-100',
        addressChecked: true,
        at: T3,
      });
      // An upgrade check keeps the current verification while it waits.
      expect(reviewing.status).toBe('verified');
      expect(reviewing.tier).toBe('basic');
      expect(reviewing.badge).toBe('verified');
      expect(reviewing.countsAsVerified).toBe(true);
      expect(reviewing.checkPending).toBe(true);
      expect(reviewing.submittedChecks).toEqual([
        KYC_CHECK.personAddress, KYC_CHECK.personIdentity,
      ]);

      const enhanced = provider.resolveCheck('ada', T4);
      expect(enhanced.tier).toBe('enhanced');
      expect(enhanced.status).toBe('verified');
      expect(enhanced.history.at(-1)?.how).toBe('tier_raised');
      expect(enhanced.history.at(-1)?.at).toBe(T4);
      expect(enhanced.history.at(-1)?.rulesVersion).toBe(KYC_TIER_RULES.version);

      const expired = provider.expireVerification('ada', T5, true);
      expect(expired.badge).toBe('expired');
      expect(expired.status).toBe('unverified');
      expect(expired.tier).toBe('none');
      expect(expired.countsAsVerified).toBe(false);
      expect(expired.verifiedAt).toBeUndefined();
      expect(provider.fetchStatus(expired.entity, T5)).toEqual({
        status: 'unverified',
        tier: 'none',
        provider: provider.name,
        checkedAt: T5,
      });
      expect(expired.policyInput.badge).toBe('expired');
      expect(expired.history.map((row) => row.how)).toEqual([
        'registered',
        'check_submitted',
        'vendor_approved',
        'check_submitted',
        'tier_raised',
        'expired',
      ]);
    });
  });

  test('rejects, holds, and accepts a later person check', () => {
    withKyc((provider) => {
      person(provider, 'rejected', 'DOC-REJECT-1');
      provider.submitCheck({
        kind: 'person',
        entityId: 'rejected',
        documentId: 'DOC-REJECT-1',
        at: T1,
      });
      const rejected = provider.resolveCheck('rejected', T2);
      expect(rejected.status).toBe('rejected');
      expect(rejected.badge).toBe('rejected');
      expect(rejected.tier).toBe('none');
      expect(rejected.history.at(-1)?.how).toBe('vendor_rejected');

      provider.submitCheck({
        kind: 'person',
        entityId: 'rejected',
        documentId: 'DOC-200',
        at: T3,
      });
      const approved = provider.resolveCheck('rejected', T4);
      expect(approved.status).toBe('verified');
      expect(approved.tier).toBe('basic');
      expect(approved.history.map((row) => row.how)).toEqual([
        'registered',
        'check_submitted',
        'vendor_rejected',
        'check_submitted',
        'vendor_approved',
      ]);

      person(provider, 'hold', 'DOC-HOLD-1');
      provider.submitCheck({
        kind: 'person', entityId: 'hold', documentId: 'DOC-HOLD-1', at: T1,
      });
      const held = provider.resolveCheck('hold', T2);
      expect(held.status).toBe('pending');
      expect(held.badge).toBe('pending');
      expect(held.history.at(-1)?.how).toBe('vendor_hold');
    });
  });

  test('moves a business through basic, enhanced, and rejection', () => {
    withKyc((provider) => {
      provider.registerEntity({
        id: 'shop',
        displayName: 'Shop',
        roles: ['seller'],
        wallets: ['wallet-shop'],
        kind: 'business',
        registrationNumber: 'REG-100',
        at: T0,
      });
      expectCode(() => provider.submitCheck({
        kind: 'person',
        entityId: 'shop',
        documentId: 'DOC-100',
        at: T1,
      }), 'kind_mismatch');

      const pending = provider.submitCheck({
        kind: 'business',
        entityId: 'shop',
        registrationNumber: 'REG-100',
        at: T1,
      });
      expect(pending.submittedChecks).toEqual([KYC_CHECK.businessRegistration]);
      const basic = provider.resolveCheck('shop', T2);
      expect(basic.tier).toBe('basic');
      expect(basic.subjectKind).toBe('business');
      expect(basic.countsAsVerified).toBe(true);

      provider.submitCheck({
        kind: 'business',
        entityId: 'shop',
        registrationNumber: 'REG-100',
        beneficialOwnerDocumentId: 'BO-100',
        at: T3,
      });
      const enhanced = provider.resolveCheck('shop', T4);
      expect(enhanced.tier).toBe('enhanced');
      expect(enhanced.submittedChecks).toEqual([
        KYC_CHECK.businessBeneficialOwner,
        KYC_CHECK.businessRegistration,
      ]);
      expect(enhanced.history.at(-1)?.how).toBe('tier_raised');

      provider.registerEntity({
        id: 'reg-reject',
        displayName: 'Reg reject',
        roles: ['buyer', 'seller'],
        wallets: ['wallet-reg-reject'],
        kind: 'business',
        at: T0,
      });
      provider.submitCheck({
        kind: 'business',
        entityId: 'reg-reject',
        registrationNumber: 'REG-REJECT-9',
        at: T1,
      });
      expect(provider.resolveCheck('reg-reject', T2).status).toBe('rejected');

      provider.registerEntity({
        id: 'bo-reject',
        displayName: 'Owner reject',
        roles: ['seller'],
        wallets: ['wallet-bo-reject'],
        kind: 'business',
        at: T0,
      });
      provider.submitCheck({
        kind: 'business',
        entityId: 'bo-reject',
        registrationNumber: 'REG-500',
        beneficialOwnerDocumentId: 'BO-REJECT-1',
        at: T1,
      });
      const ownerRejected = provider.resolveCheck('bo-reject', T2);
      expect(ownerRejected.status).toBe('rejected');
      expect(ownerRejected.history.at(-1)?.how).toBe('vendor_rejected');

      provider.registerEntity({
        id: 'reg-hold',
        displayName: 'Reg hold',
        roles: ['buyer'],
        wallets: ['wallet-reg-hold'],
        kind: 'business',
        at: T0,
      });
      provider.submitCheck({
        kind: 'business',
        entityId: 'reg-hold',
        registrationNumber: 'REG-HOLD-1',
        at: T1,
      });
      const held = provider.resolveCheck('reg-hold', T2);
      expect(held.status).toBe('pending');
      expect(held.history.at(-1)?.how).toBe('vendor_hold');
    });
  });

  test('uses an entity script and ignores demo prefixes when scripts are empty', () => {
    withKyc((provider) => {
      person(provider, 'scripted', 'DOC-100');
      provider.submitCheck({
        kind: 'person', entityId: 'scripted', documentId: 'DOC-100', at: T1,
      });
      expect(provider.resolveCheck('scripted', T2).status).toBe('rejected');
    }, {scripts: [{entityId: 'scripted', decision: 'reject'}]});

    withKyc((provider) => {
      person(provider, 'open', 'DOC-REJECT-1');
      provider.submitCheck({
        kind: 'person', entityId: 'open', documentId: 'DOC-REJECT-1', at: T1,
      });
      expect(provider.resolveCheck('open', T2).status).toBe('verified');
    }, {scripts: []});
  });
});

describe('submissions and upgrades', () => {
  test('replaces earlier checks and documents on each submission', () => {
    withKyc((provider, store) => {
      provider.registerEntity({
        id: 'owner-retry',
        displayName: 'Owner retry',
        roles: ['seller'],
        wallets: ['wallet-owner-retry'],
        kind: 'business',
        at: T0,
      });
      provider.submitCheck({
        kind: 'business',
        entityId: 'owner-retry',
        registrationNumber: 'REG-700',
        beneficialOwnerDocumentId: 'BO-REJECT-7',
        at: T1,
      });
      expect(provider.resolveCheck('owner-retry', T2).status).toBe('rejected');

      const retry = provider.submitCheck({
        kind: 'business',
        entityId: 'owner-retry',
        registrationNumber: 'REG-700',
        at: T3,
      });
      expect(retry.submittedChecks).toEqual([KYC_CHECK.businessRegistration]);
      expect(store.getKycProfile('owner-retry')?.beneficialOwnerDocumentId)
        .toBeUndefined();
      const basic = provider.resolveCheck('owner-retry', T4);
      expect(basic.status).toBe('verified');
      expect(basic.tier).toBe('basic');
    });
  });

  test('needs new checks after expiry', () => {
    withKyc((provider) => {
      person(provider, 'lapsed', 'DOC-300');
      provider.submitCheck({
        kind: 'person',
        entityId: 'lapsed',
        documentId: 'DOC-300',
        addressChecked: true,
        at: T1,
      });
      expect(provider.resolveCheck('lapsed', T2).tier).toBe('enhanced');
      const expired = provider.expireVerification('lapsed', T3, true);
      expect(expired.submittedChecks).toEqual([]);
      expect(expired.checkPending).toBe(false);

      provider.submitCheck({
        kind: 'person', entityId: 'lapsed', documentId: 'DOC-300', at: T4,
      });
      const renewed = provider.resolveCheck('lapsed', T5);
      expect(renewed.tier).toBe('basic');
      expect(renewed.history.at(-1)?.how).toBe('vendor_approved');
    });
  });

  test('keeps the current tier when an upgrade is rejected or held', () => {
    withKyc((provider) => {
      provider.registerEntity({
        id: 'growing',
        displayName: 'Growing',
        roles: ['seller'],
        wallets: ['wallet-growing'],
        kind: 'business',
        at: T0,
      });
      provider.submitCheck({
        kind: 'business',
        entityId: 'growing',
        registrationNumber: 'REG-800',
        at: T1,
      });
      const basic = provider.resolveCheck('growing', T2);
      expect(basic.tier).toBe('basic');

      const waiting = provider.submitCheck({
        kind: 'business',
        entityId: 'growing',
        registrationNumber: 'REG-800',
        beneficialOwnerDocumentId: 'BO-REJECT-8',
        at: T3,
      });
      expect(waiting.status).toBe('verified');
      expect(waiting.tier).toBe('basic');
      expect(waiting.countsAsVerified).toBe(true);
      expect(waiting.checkPending).toBe(true);

      const refused = provider.resolveCheck('growing', T4);
      expect(refused.status).toBe('verified');
      expect(refused.tier).toBe('basic');
      expect(refused.badge).toBe('verified');
      expect(refused.countsAsVerified).toBe(true);
      expect(refused.checkPending).toBe(false);
      expect(refused.verifiedAt).toBe(basic.verifiedAt);
      expect(refused.history.at(-1)?.how).toBe('vendor_rejected');
      expectCode(() => provider.resolveCheck('growing', T5), 'not_pending');
    });

    withKyc((provider) => {
      person(provider, 'held-upgrade', 'DOC-400');
      provider.submitCheck({
        kind: 'person', entityId: 'held-upgrade', documentId: 'DOC-400', at: T1,
      });
      provider.resolveCheck('held-upgrade', T2);
      provider.submitCheck({
        kind: 'person',
        entityId: 'held-upgrade',
        documentId: 'DOC-HOLD-4',
        addressChecked: true,
        at: T3,
      });
      const held = provider.resolveCheck('held-upgrade', T4);
      expect(held.status).toBe('verified');
      expect(held.tier).toBe('basic');
      expect(held.checkPending).toBe(true);
      expect(held.history.at(-1)?.how).toBe('vendor_hold');
    });
  });
});

describe('entities created outside KYC onboarding', () => {
  test('shows and onboards seeded and lifecycle entities', () => {
    withKyc((provider, store) => {
      store.insertEntity(ENTITY);
      const seeded = provider.view(ENTITY.id);
      expect(seeded.subjectKind).toBeNull();
      expect(seeded.status).toBe('verified');
      expect(seeded.tier).toBe('enhanced');
      expect(seeded.badge).toBe('verified');
      expect(seeded.countsAsVerified).toBe(true);
      expect(seeded.checkPending).toBe(false);
      expect(seeded.history).toEqual([]);
      expect(seeded.submittedChecks).toEqual([]);
      expectCode(() => provider.expireVerification(ENTITY.id, T1), 'not_due');
      const expired = provider.expireVerification(ENTITY.id, T1, true);
      expect(expired.badge).toBe('expired');
      expect(expired.status).toBe('unverified');
      expect(store.getKycProfile(ENTITY.id)).toBeUndefined();

      store.insertEntity({
        id: 'party',
        displayName: 'party',
        wallets: [],
        kycStatus: 'unverified',
        kycTier: 'none',
        roles: ['buyer', 'seller'],
        createdAt: T0,
      });
      expect(provider.view('party').badge).toBe('unverified');
      const pending = provider.submitCheck({
        kind: 'person', entityId: 'party', documentId: 'DOC-500', at: T2,
      });
      expect(pending.subjectKind).toBe('person');
      expect(pending.status).toBe('pending');
      expect(provider.resolveCheck('party', T3).tier).toBe('basic');
    });
  });
});

describe('KYC times and ids', () => {
  test('stores UTC times and keeps the badge in line with the status', () => {
    withKyc((provider) => {
      const registered = person(
        provider, 'zone', 'DOC-600', '2026-10-06T08:30:00+08:00',
      );
      expect(registered.history[0]?.at).toBe('2026-10-06T00:30:00.000Z');
      expect(registered.entity.createdAt).toBe('2026-10-06T00:30:00.000Z');
      const pending = provider.submitCheck({
        kind: 'person',
        entityId: 'zone',
        documentId: 'DOC-600',
        at: '2026-10-06T01:00:00Z',
      });
      expect(pending.history.map((row) => row.how)).toEqual([
        'registered', 'check_submitted',
      ]);
      expect(pending.badge).toBe('pending');
      expectCode(() => provider.resolveCheck('zone', 'not a time'), 'bad_time');

      provider.resolveCheck('zone', '2026-10-06T02:00:00Z');
      const expired = provider.expireVerification(
        'zone', '2027-10-07T00:00:00Z',
      );
      expect(expired.badge).toBe('expired');
      // A later step with an earlier time still sets the badge.
      const again = provider.submitCheck({
        kind: 'person',
        entityId: 'zone',
        documentId: 'DOC-600',
        at: '2026-10-07T00:00:00Z',
      });
      expect(again.status).toBe('pending');
      expect(again.badge).toBe('pending');
      expect(again.policyInput.badge).toBe('pending');
      expect(again.history.at(-1)?.how).toBe('check_submitted');
    });
  });

  test('trims entity ids in every call', () => {
    withKyc((provider) => {
      expect(person(provider, ' p4 ', 'DOC-700').entity.id).toBe('p4');
      provider.submitCheck({
        kind: 'person', entityId: ' p4 ', documentId: 'DOC-700', at: T1,
      });
      expect(provider.resolveCheck(' p4 ', T2).status).toBe('verified');
      expect(provider.attachWallet(' p4 ', 'wallet-p4-2', T3).entity.wallets)
        .toContain('wallet-p4-2');
      expect(provider.view(' p4 ').status).toBe('verified');
      expect(provider.expireVerification(' p4 ', T4, true).badge)
        .toBe('expired');
    });
  });
});

describe('KYC tier config', () => {
  test('counts a default verified basic entity and hides weaker rows', () => {
    expect(countsAsVerified('verified', 'basic')).toBe(true);
    expect(countsAsVerified('verified', 'enhanced')).toBe(true);
    expect(countsAsVerified('verified', 'none')).toBe(false);
    expect(countsAsVerified('pending', 'enhanced')).toBe(false);
    expect(countsAsVerified('rejected', 'basic')).toBe(false);
    expect(countsAsVerified('unverified', 'none')).toBe(false);
    expect(tierForSubmittedChecks('person', [KYC_CHECK.personIdentity])).toBe('basic');
    expect(tierForSubmittedChecks('person', [
      KYC_CHECK.personIdentity, KYC_CHECK.personAddress,
    ])).toBe('enhanced');
    expect(tierForSubmittedChecks('business', [
      KYC_CHECK.businessRegistration,
    ])).toBe('basic');
    expect(tierForSubmittedChecks('business', [])).toBe('none');
  });

  test('follows a replacement rules object', () => {
    const rules: KycTierRules = {
      ...KYC_TIER_RULES,
      version: 'kyc-tier-rules-test',
      countsAsVerified: {requireStatus: 'verified', minimumTier: 'enhanced'},
      person: {
        basic: [KYC_CHECK.personIdentity, KYC_CHECK.personAddress],
        enhanced: [
          KYC_CHECK.personIdentity,
          KYC_CHECK.personAddress,
          'liveness',
        ],
      },
      verificationTtlMs: 1000,
    };
    expect(countsAsVerified('verified', 'basic', rules)).toBe(false);
    expect(countsAsVerified('verified', 'enhanced', rules)).toBe(true);
    expect(tierForSubmittedChecks(
      'person', [KYC_CHECK.personIdentity], rules,
    )).toBe('none');

    withKyc((provider) => {
      person(provider, 'short', 'DOC-100');
      provider.submitCheck({
        kind: 'person', entityId: 'short', documentId: 'DOC-100', at: T1,
      });
      const short = provider.resolveCheck('short', T2);
      expect(short.status).toBe('pending');
      expect(short.tier).toBe('none');
      expect(short.history.at(-1)?.how).toBe('checks_short_of_tier');
      expect(short.rulesVersion).toBe('kyc-tier-rules-test');
      expect(short.countsAsVerified).toBe(false);

      provider.submitCheck({
        kind: 'person',
        entityId: 'short',
        documentId: 'DOC-100',
        addressChecked: true,
        at: T3,
      });
      const basic = provider.resolveCheck('short', T4);
      expect(basic.status).toBe('verified');
      expect(basic.tier).toBe('basic');
      expect(basic.countsAsVerified).toBe(false);
      expect(basic.history.at(-1)?.rulesVersion).toBe(rules.version);

      const early = '2026-10-06T00:04:00.999Z';
      const due = '2026-10-06T00:04:01.000Z';
      expectCode(
        () => provider.expireVerification('short', early),
        'not_due',
      );
      expect(provider.view('short').status).toBe('verified');
      const expired = provider.expireVerification('short', due);
      expect(expired.badge).toBe('expired');
      expect(expired.status).toBe('unverified');
    }, {rules});
  });

  test('lists one fixture for each badge', () => {
    const badges = new Set(KYC_FIXTURE_CASES.map((row) => row.badge));
    expect([...badges].sort()).toEqual([...KYC_BADGES].sort());
    expect(KYC_FIXTURE_CASES.some((row) => row.tier === 'basic')).toBe(true);
    expect(KYC_FIXTURE_CASES.some((row) => row.tier === 'enhanced')).toBe(true);
    expect(KYC_FIXTURE_CASES.some((row) => row.reRegistrationOf !== null)).toBe(true);
    const expired = KYC_FIXTURE_CASES.find((row) => row.badge === 'expired');
    expect(expired?.status).toBe('unverified');
    expect(expired?.countsAsVerified).toBe(false);
  });
});

describe('re-registration and wallets', () => {
  test('flags the same document and does not copy reliability', () => {
    withKyc((provider, store) => {
      person(provider, 'first', 'DOC-SAME');
      provider.submitCheck({
        kind: 'person', entityId: 'first', documentId: 'DOC-SAME', at: T1,
      });
      const verified = provider.resolveCheck('first', T2);
      expect(verified.tier).toBe('basic');
      store.saveReliabilityState({
        entityId: 'first',
        category: 'payment',
        role: 'seller',
        alpha: 8,
        beta: 2,
        eventCount: 6,
        updatedAt: T2,
      });

      const second = provider.registerEntity({
        id: 'second',
        displayName: 'Second',
        roles: ['seller'],
        wallets: ['wallet-second'],
        kind: 'person',
        documentId: 'DOC-SAME',
        at: T3,
      });
      expect(second.reRegistration).toEqual({
        ofEntityId: 'first',
        signal: 'document',
        matchedValue: 'DOC-SAME',
      });
      expect(second.status).toBe('unverified');
      expect(second.tier).toBe('none');
      expect(second.policyInput.reRegistrationOf).toBe('first');
      expect(store.getReliabilityState('second', 'payment', 'seller')).toBeUndefined();
      expect(store.getReliabilityState('first', 'payment', 'seller')?.alpha).toBe(8);

      provider.submitCheck({
        kind: 'person', entityId: 'second', documentId: 'DOC-SAME', at: T4,
      });
      const stillFlagged = provider.resolveCheck('second', T5);
      expect(stillFlagged.status).toBe('verified');
      expect(stillFlagged.reRegistration?.ofEntityId).toBe('first');
      expect(store.listReliabilityStates().map((row) => row.entityId)).toEqual([
        'first',
      ]);
      expect(store.getReliabilityState('first', 'payment', 'seller')?.eventCount).toBe(6);

      expectCode(() => provider.registerEntity({
        id: 'third',
        displayName: 'Third',
        roles: ['buyer'],
        wallets: ['wallet-first'],
        kind: 'person',
        documentId: 'DOC-OTHER',
        at: T5,
      }), 'wallet_in_use');
      expect(store.getEntity('third')).toBeUndefined();
      expect(store.getReliabilityState('first', 'payment', 'seller')?.alpha).toBe(8);
    });
  });

  test('flags a registration number and a beneficial owner document', () => {
    withKyc((provider, store) => {
      provider.registerEntity({
        id: 'co-a',
        displayName: 'Company A',
        roles: ['seller'],
        wallets: ['wallet-co-a'],
        kind: 'business',
        registrationNumber: 'REG-SAME',
        at: T0,
      });
      const coB = provider.registerEntity({
        id: 'co-b',
        displayName: 'Company B',
        roles: ['buyer'],
        wallets: ['wallet-co-b'],
        kind: 'business',
        registrationNumber: 'REG-SAME',
        at: T1,
      });
      expect(coB.reRegistration).toEqual({
        ofEntityId: 'co-a',
        signal: 'registration_number',
        matchedValue: 'REG-SAME',
      });
      expect(store.listReliabilityStates()).toEqual([]);

      // A person who owns a company is not a re-registration of it.
      person(provider, 'owner', 'DOC-OWNER');
      const owned = provider.registerEntity({
        id: 'co-c',
        displayName: 'Company C',
        roles: ['seller'],
        wallets: ['wallet-co-c'],
        kind: 'business',
        registrationNumber: 'REG-NEW',
        beneficialOwnerDocumentId: 'DOC-OWNER',
        at: T2,
      });
      expect(owned.reRegistration).toBeNull();
      expect(provider.view('owner').reRegistration).toBeNull();

      const sameOwner = provider.registerEntity({
        id: 'co-d',
        displayName: 'Company D',
        roles: ['seller'],
        wallets: ['wallet-co-d'],
        kind: 'business',
        registrationNumber: 'REG-OTHER',
        beneficialOwnerDocumentId: 'DOC-OWNER',
        at: T3,
      });
      expect(sameOwner.reRegistration).toEqual({
        ofEntityId: 'co-c',
        signal: 'beneficial_owner',
        matchedValue: 'DOC-OWNER',
      });
      expect(sameOwner.policyInput.reRegistrationSignal).toBe(
        'beneficial_owner',
      );
    });
  });

  test('matches a document that the entity has since replaced', () => {
    withKyc((provider) => {
      person(provider, 'changed', 'DOC-X');
      provider.submitCheck({
        kind: 'person', entityId: 'changed', documentId: 'DOC-X', at: T1,
      });
      provider.submitCheck({
        kind: 'person', entityId: 'changed', documentId: 'DOC-Y', at: T2,
      });
      const later = person(provider, 'later', 'DOC-X', T3);
      expect(later.reRegistration).toEqual({
        ofEntityId: 'changed',
        signal: 'document',
        matchedValue: 'DOC-X',
      });
    });
  });

  test('points every match at the entity created first', () => {
    withKyc((provider) => {
      person(provider, 'zed', 'DOC-1', T0);
      expect(person(provider, 'abe', 'DOC-1', T1).reRegistration?.ofEntityId)
        .toBe('zed');
      expect(person(provider, 'mid', 'DOC-1', T2).reRegistration?.ofEntityId)
        .toBe('zed');
      expect(provider.view('zed').reRegistration).toBeNull();
    });

    withKyc((provider) => {
      // The older entity submits the document after a newer one used it.
      person(provider, 'older', undefined, T0);
      person(provider, 'newer', 'DOC-2', T1);
      const older = provider.submitCheck({
        kind: 'person', entityId: 'older', documentId: 'DOC-2', at: T2,
      });
      expect(older.reRegistration).toBeNull();
      expect(provider.view('newer').reRegistration).toEqual({
        ofEntityId: 'older',
        signal: 'document',
        matchedValue: 'DOC-2',
      });
    });
  });

  test('does not treat a new wallet as inherited reliability', () => {
    withKyc((provider, store) => {
      const first = person(provider, 'alpha', 'DOC-A');
      provider.submitCheck({
        kind: 'person',
        entityId: 'alpha',
        documentId: 'DOC-A',
        addressChecked: true,
        at: T1,
      });
      provider.resolveCheck('alpha', T2);
      store.saveReliabilityState({
        entityId: 'alpha',
        category: 'fulfillment',
        role: 'buyer',
        alpha: 4,
        beta: 1,
        eventCount: 3,
        updatedAt: T2,
      });
      const second = person(provider, 'beta', 'DOC-B');
      expect(second.reRegistration).toBeNull();
      expect(second.entity.wallets).toEqual(['wallet-beta']);
      expect(second.entity.wallets).not.toEqual(first.entity.wallets);
      provider.attachWallet('beta', 'wallet-beta-2', T3);
      expect(store.getEntity('beta')?.kycStatus).toBe('unverified');
      expect(store.getReliabilityState('beta', 'fulfillment', 'buyer')).toBeUndefined();
      expect(store.getReliabilityState('alpha', 'fulfillment', 'buyer')?.alpha).toBe(4);
      expectCode(
        () => provider.attachWallet('beta', 'wallet-alpha', T4),
        'wallet_in_use',
      );
      expect(store.getEntity('beta')?.wallets).toEqual([
        'wallet-beta', 'wallet-beta-2',
      ]);
      expect(store.listReliabilityStates()).toHaveLength(1);
    });
  });
});
