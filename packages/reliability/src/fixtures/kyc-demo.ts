/**
 * @fileoverview KYC badge examples for the UI lane.
 * These rows are not marketplace entities. They show each badge.
 * The mock check is not a live vendor call.
 */

import {
  countsAsVerified, type KycBadge, type KycHow, type KycSubjectKind,
} from '../kyc';
import type {KycStatus, KycTier} from '../types';

/** One badge example. `reRegistrationOf` is set only for the flag case. */
export interface KycFixtureCase {
  id: string;
  label: string;
  badge: KycBadge;
  status: KycStatus;
  tier: KycTier;
  subjectKind: KycSubjectKind;
  countsAsVerified: boolean;
  reRegistrationOf: string|null;
  how: KycHow;
}

/** One example of each badge, plus basic and enhanced tiers. */
export const KYC_FIXTURE_CASES: readonly KycFixtureCase[] = [
  {
    id: 'kyc-unverified',
    label: 'Registered person. No check yet.',
    badge: 'unverified',
    status: 'unverified',
    tier: 'none',
    subjectKind: 'person',
    countsAsVerified: countsAsVerified('unverified', 'none'),
    reRegistrationOf: null,
    how: 'registered',
  },
  {
    id: 'kyc-pending',
    label: 'Person check is waiting on the mock vendor.',
    badge: 'pending',
    status: 'pending',
    tier: 'none',
    subjectKind: 'person',
    countsAsVerified: countsAsVerified('pending', 'none'),
    reRegistrationOf: null,
    how: 'check_submitted',
  },
  {
    id: 'kyc-verified-basic',
    label: 'Person verified at tier basic.',
    badge: 'verified',
    status: 'verified',
    tier: 'basic',
    subjectKind: 'person',
    countsAsVerified: countsAsVerified('verified', 'basic'),
    reRegistrationOf: null,
    how: 'vendor_approved',
  },
  {
    id: 'kyc-verified-enhanced',
    label: 'Business verified at tier enhanced.',
    badge: 'verified',
    status: 'verified',
    tier: 'enhanced',
    subjectKind: 'business',
    countsAsVerified: countsAsVerified('verified', 'enhanced'),
    reRegistrationOf: null,
    how: 'tier_raised',
  },
  {
    id: 'kyc-rejected',
    label: 'Mock vendor rejected the check.',
    badge: 'rejected',
    status: 'rejected',
    tier: 'none',
    subjectKind: 'business',
    countsAsVerified: countsAsVerified('rejected', 'none'),
    reRegistrationOf: null,
    how: 'vendor_rejected',
  },
  {
    id: 'kyc-expired',
    label: 'Verification expired. Entity status is unverified.',
    badge: 'expired',
    status: 'unverified',
    tier: 'none',
    subjectKind: 'person',
    countsAsVerified: countsAsVerified('unverified', 'none'),
    reRegistrationOf: null,
    how: 'expired',
  },
  {
    id: 'kyc-reregistration',
    label: 'Same mocked document as kyc-unverified. Reliability is not copied.',
    badge: 'unverified',
    status: 'unverified',
    tier: 'none',
    subjectKind: 'person',
    countsAsVerified: countsAsVerified('unverified', 'none'),
    reRegistrationOf: 'kyc-unverified',
    how: 'registered',
  },
];
