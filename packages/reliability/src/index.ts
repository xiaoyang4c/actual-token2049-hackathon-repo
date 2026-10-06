/**
 * @fileoverview Public entry point for the reliability marketplace package.
 * The domain types file (types.ts) is frozen after the plumbing PR. Lane
 * owners request type changes through a separate small PR, never inside
 * a lane PR.
 */

export type {
  Entity,
  EntityRole,
  JsonValue,
  KycStatus,
  KycTier,
  Listing,
  MarketplaceTransaction,
  Outcome,
  OutcomeState,
  Receipt,
  ReliabilityCategory,
  ReliabilityEvent,
  ReliabilityOutcome,
  ReliabilityState,
  ScoreView,
  TermsDecision,
  TermsOffer,
  TermsReasonCode,
  TermsVersion,
  TransactionParticipant,
  TransactionType,
  VerificationMethod,
} from './types';
export {
  STUB_SCORING_VERSION,
  stubInitialState,
  StubScoringPolicy,
  type ScoringPolicy,
} from './scoring';
export {
  STUB_PAIR_DECAY_VERSION,
  StubPairDecay,
  type PairDecay,
} from './pair-decay';
export {
  STUB_FEE_TERMS_VERSION,
  StubFeeTermsPolicy,
  type FeeTermsPolicy,
  type TermsPolicyInput,
} from './fees-policy';
export {
  STUB_LIFECYCLE_VERSION,
  StubTransactionLifecycle,
  type LifecycleStage,
  type LifecycleTransition,
  type TransactionLifecycle,
} from './lifecycle';
export {
  STUB_PAYMENT_EVIDENCE_VERSION,
  hashInvoiceTerms,
  StubPaymentEvidenceProducer,
  type PaymentEvidenceProducer,
  type PaymentVerificationInput,
} from './evidence-payment';
export {
  DEMO_KYC_SCRIPTS,
  KYC_BADGES,
  KYC_CHECK,
  KYC_TIER_RULES,
  MOCK_KYC_PROVIDER_NAME,
  MockKycProvider,
  countsAsVerified,
  tierForSubmittedChecks,
  type KycBadge,
  type KycCheckInput,
  type KycFlowErrorCode,
  type KycHow,
  type KycPolicyInput,
  type KycProfile,
  type KycProvider,
  type KycRecordStore,
  type KycReRegistration,
  type KycResult,
  type KycScript,
  type KycStatusRecord,
  type KycSubjectKind,
  type KycTierRules,
  type KycVendorDecision,
  type KycView,
  type MockKycOptions,
  type RegisterEntityInput,
  KycFlowError,
} from './kyc';
export {
  applyEventsToStates,
  categoryForType,
  outcomeToEvents,
  refreshTermsDecisions,
} from './event-flow';
export {
  FARM_OUTCOMES,
  FARM_TRANSACTIONS,
  FIXTURE_ENTITIES,
  KYC_FIXTURE_CASES,
  FIXTURE_LISTINGS,
  FIXTURE_OUTCOMES,
  FIXTURE_STATES,
  FIXTURE_TRANSACTIONS,
  OUTCOME_INVOICE,
  OUTCOME_SERVICE,
  TX_INVOICE,
  TX_SERVICE,
  type KycFixtureCase,
} from './fixtures/index';
