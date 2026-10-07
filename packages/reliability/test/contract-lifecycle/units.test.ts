/**
 * @fileoverview Pure units of the contract lifecycle: canonical JSON,
 * MIP-004 hashes, signatures, remedies, fees, deadlines, templates.
 */

import {describe, expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {canonicalize} from '../../src/contract-lifecycle/canonical-json';
import {
  assertDisputeBudget, computeDeadlines, inspectionCutoff, validateDeadlines,
} from '../../src/contract-lifecycle/deadlines';
import {disputeFee} from '../../src/contract-lifecycle/fees';
import {isIdentifierFromPurchaser, mip004InputHash, mip004ResultHash, newIdentifierFromPurchaser} from '../../src/contract-lifecycle/hashing';
import {
  allowedOutcomes, decisionsFor, decisionsForOutcome, trancheLayout, validateRemedy, winnerOfOutcome,
} from '../../src/contract-lifecycle/remedies';
import {generateEd25519, signBytes, verifyBytes} from '../../src/contract-lifecycle/signatures';
import {deliverableProblems, TemplateRegistry} from '../../src/contract-lifecycle/templates';
import type {Tranche, WindowSet} from '../../src/contract-lifecycle/types';

const sha = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('canonical JSON (RFC 8785)', () => {
  test('sorts keys by UTF-16 code units and drops whitespace', () => {
    // Upper-case keys sort before lower-case ones (UTF-16 order).
    expect(canonicalize(JSON.parse('{"b":1,"a":[true,null,"x"],"A":{}}'))).toBe('{"A":{},"a":[true,null,"x"],"b":1}');
  });

  test('uses the ECMAScript number form', () => {
    expect(canonicalize([1e21, 1e-7, -0, 0.1])).toBe('[1e+21,1e-7,0,0.1]');
  });

  test('sorts non-ASCII keys as RFC 8785 section 3.2.3 shows', () => {
    const input = {'\u20ac': 'Euro', '\r': 'CR', '\ufb33': 'Dalet', '1': 'One', '\ud83d\ude00': 'Emoji', '\u0080': 'Control', '\u00f6': 'o'};
    expect(canonicalize(input)).toBe('{"\\r":"CR","1":"One","\u0080":"Control","\u00f6":"o","\u20ac":"Euro","\ud83d\ude00":"Emoji","\ufb33":"Dalet"}');
  });

  test('rejects values JCS cannot represent', () => {
    expect(() => canonicalize(Number.NaN)).toThrow();
    expect(() => canonicalize(10n)).toThrow();
    expect(() => canonicalize(new Date(0))).toThrow();
    expect(() => canonicalize('\ud800')).toThrow();
  });
});

describe('MIP-004 hashes', () => {
  const id = 'a1b2c3d4e5f60718293a';

  test('input hash is SHA-256(id + ";" + JCS(input))', () => {
    expect(mip004InputHash(id, {b: 2, a: 'x'})).toBe(sha(`${id};{"a":"x","b":2}`));
  });

  test('result hash takes the raw output: newlines, quotes, backslashes, and non-ASCII stay as they are', () => {
    const output = 'line1\nline2 "quoted" back\\slash ünïcødé';
    expect(mip004ResultHash(id, output)).toBe(sha(`${id};${output}`));
    expect(mip004ResultHash(id, output)).not.toBe(sha(`${id};${JSON.stringify(output)}`));
  });

  test('a plain SHA-256 of the payload is not a MIP-004 hash', () => {
    expect(mip004ResultHash(id, 'x')).not.toBe(sha('x'));
  });

  test('nonces are 14 to 26 lowercase hex characters, as MPS requires', () => {
    expect(isIdentifierFromPurchaser(newIdentifierFromPurchaser())).toBe(true);
    expect(isIdentifierFromPurchaser('tx-demo')).toBe(false);
    expect(() => mip004ResultHash('abc', 'x')).toThrow();
    expect(() => mip004ResultHash('a'.repeat(27), 'x')).toThrow();
  });
});

describe('Ed25519', () => {
  test('verifies its own signature and rejects tampering and other keys', () => {
    const key = generateEd25519();
    const other = generateEd25519();
    const signature = signBytes(key.privateKey, 'terms');
    expect(verifyBytes(key.publicKeyHex, 'terms', signature)).toBe(true);
    expect(verifyBytes(key.publicKeyHex, 'terms!', signature)).toBe(false);
    expect(verifyBytes(other.publicKeyHex, 'terms', signature)).toBe(false);
    expect(verifyBytes(key.publicKeyHex, 'terms', 'zz')).toBe(false);
  });
});

describe('remedies', () => {
  const tranche = (role: Tranche['role'], id: string) => ({id, role}) as Tranche;

  test('partial_release splits into a core and a holdback that sum to the amount', () => {
    expect(trancheLayout(10_000_001n, {type: 'partial_release', sellerShareBps: 7000})).toEqual([
      {role: 'core', amountAtomic: '7000000'},
      {role: 'holdback', amountAtomic: '3000001'},
    ]);
  });

  test('other remedies use one escrow', () => {
    for (const type of ['full_refund_with_return', 'full_refund_no_return', 'redo_or_replace'] as const) {
      expect(trancheLayout(5n, {type})).toEqual([{role: 'full', amountAtomic: '5'}]);
    }
  });

  test('rejects bad remedies and amounts too small to split', () => {
    expect(() => validateRemedy({type: 'partial_release'})).toThrow();
    expect(() => validateRemedy({type: 'partial_release', sellerShareBps: 10000})).toThrow();
    expect(() => validateRemedy({type: 'full_refund_no_return', sellerShareBps: 10})).toThrow();
    expect(() => trancheLayout(1n, {type: 'partial_release', sellerShareBps: 5000})).toThrow();
    expect(() => trancheLayout(0n, {type: 'full_refund_no_return'})).toThrow();
  });

  test('decisions follow the remedy and the winner', () => {
    const split = [tranche('core', 'c'), tranche('holdback', 'h')];
    expect(decisionsFor({type: 'partial_release', sellerShareBps: 7000}, 'buyer', split)).toEqual({c: 'release', h: 'refund'});
    expect(decisionsFor({type: 'partial_release', sellerShareBps: 7000}, 'seller', split)).toEqual({c: 'release', h: 'release'});
    expect(decisionsFor({type: 'full_refund_no_return'}, 'buyer', [tranche('full', 'f')])).toEqual({f: 'refund'});
  });

  test('Tier 1 offers only fixed outcomes that the escrows can express', () => {
    const split = [tranche('core', 'c'), tranche('holdback', 'h')];
    const single = [tranche('full', 'f')];
    expect(allowedOutcomes(split)).toEqual(['full_release', 'core_only', 'full_refund']);
    expect(allowedOutcomes(single)).toEqual(['full_release', 'full_refund']);
    expect(decisionsForOutcome('core_only', split)).toEqual({c: 'release', h: 'refund'});
    expect(() => decisionsForOutcome('core_only', single)).toThrow(/not possible/);
    expect(['full_release', 'core_only', 'full_refund'].map((item) => winnerOfOutcome(item as 'core_only'))).toEqual(['seller', 'split', 'buyer']);
  });
});

describe('dispute fees', () => {
  const rules = {rule: 'loser_pays' as const, perTierAtomic: {tier1: '0', tier2: '100', tier3: '5000'}};

  test('the loser pays the fees of every tier reached', () => {
    expect(disputeFee(rules, 3, 'buyer')).toEqual({amountAtomic: '5100', paidBy: 'seller'});
    expect(disputeFee(rules, 2, 'seller')).toEqual({amountAtomic: '100', paidBy: 'buyer'});
    expect(disputeFee(rules, 3, 'split')).toEqual({amountAtomic: '5100', paidBy: 'split'});
    expect(disputeFee(rules, 1, 'buyer')).toEqual({amountAtomic: '0', paidBy: null});
  });

  test('a template rule overrides loser pays', () => {
    expect(disputeFee({...rules, rule: 'buyer_pays'}, 3, 'buyer')).toEqual({amountAtomic: '5100', paidBy: 'buyer'});
  });
});

describe('deadlines', () => {
  const windows: WindowSet = {
    fundingWindowMs: 30 * MINUTE,
    deliveryWindowMs: 60 * MINUTE,
    inspectionWindowMs: 72 * HOUR,
    disputeResolutionWindowMs: 14 * 24 * HOUR,
    tier1WindowMs: HOUR,
    tier2WindowMs: HOUR,
    tier3WindowMs: HOUR,
    returnWindowMs: HOUR,
    redoWindowMs: HOUR,
    redoInspectionWindowMs: HOUR,
    rulingComplianceWindowMs: HOUR,
  };

  test('template windows chain into absolute Masumi deadlines', () => {
    expect(computeDeadlines(0, windows)).toEqual({
      payByTime: 30 * MINUTE,
      submitResultTime: 90 * MINUTE,
      unlockTime: 90 * MINUTE + 72 * HOUR,
      externalDisputeUnlockTime: 90 * MINUTE + 72 * HOUR + 14 * 24 * HOUR,
    });
  });

  test('live mode rejects deadlines that MPS would reject; paper mode allows them', () => {
    const short = computeDeadlines(0, {...windows, inspectionWindowMs: 5 * MINUTE});
    expect(() => validateDeadlines(short, 0, 'live')).toThrow(/unlockTime must be at least 15 minutes after submitResultTime/);
    expect(() => validateDeadlines(short, 0, 'paper')).not.toThrow();
    // The v1 lifecycle sets submitResultTime = unlockTime = externalDisputeUnlockTime. MPS rejects that.
    expect(() => validateDeadlines({payByTime: 0, submitResultTime: HOUR, unlockTime: HOUR, externalDisputeUnlockTime: HOUR}, 0, 'live')).toThrow();
  });

  test('the inspection cutoff is the smaller of delivery plus window and unlock minus margin', () => {
    const deadlines = computeDeadlines(0, windows);
    expect(inspectionCutoff(40 * MINUTE, windows, deadlines, 2 * MINUTE)).toBe(40 * MINUTE + 72 * HOUR);
    expect(inspectionCutoff(89 * MINUTE, windows, deadlines, 2 * MINUTE)).toBe(deadlines.unlockTime - 2 * MINUTE);
  });

  test('the dispute budget must fit the dispute resolution window', () => {
    expect(() => assertDisputeBudget(windows, {type: 'redo_or_replace'}, [1, 2, 3])).not.toThrow();
    expect(() => assertDisputeBudget({...windows, disputeResolutionWindowMs: 2 * HOUR}, {type: 'full_refund_no_return'}, [1, 2, 3])).toThrow();
  });
});

describe('templates', () => {
  test('five templates load; 1 and 3 are enabled, the rest are config drafts', () => {
    const registry = TemplateRegistry.fromDirectory();
    const status = Object.fromEntries(registry.list().map((template) => [template.category, template.status]));
    expect(status).toEqual({
      digital_machine_checkable: 'enabled',
      digital_subjective: 'design_only',
      physical_objective_spec: 'enabled',
      physical_subjective: 'design_only',
      ongoing_service: 'design_only',
    });
    for (const template of registry.list()) expect(template.windows.inspectionWindowMs).toBe(72 * HOUR);
  });

  test('every allowed remedy fits the dispute budget of its template', () => {
    for (const template of TemplateRegistry.fromDirectory().list()) {
      for (const type of template.remedy.allowed) {
        const remedy = type === 'partial_release' ? {type, sellerShareBps: 7000} : {type};
        expect(() => assertDisputeBudget(template.windows, remedy, template.dispute.tiers)).not.toThrow();
      }
    }
  });

  test('deliverable specs are checked against the template schema', () => {
    const schema = {required: ['a'], additionalProperties: false, properties: {a: {type: 'string', pattern: '^x'}, n: {type: 'number', minimum: 0}}};
    expect(deliverableProblems({a: 'xy'}, schema)).toEqual([]);
    expect(deliverableProblems({a: 'y', n: -1, z: 1}, schema).length).toBe(3);
    expect(deliverableProblems('nope', schema)).toEqual(['must be an object']);
  });
});
