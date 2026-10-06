/**
 * @fileoverview Public entry point for the reliability marketplace package.
 * The domain types file (types.ts) is frozen after the per-role fault
 * change. Lane owners request further type changes through a separate
 * small PR, never inside a lane PR.
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
  OutcomeFault,
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
  DELIVERY_TIER_VERIFICATION,
  DELIVERY_TIERS,
  EscrowTransactionLifecycle,
  LIFECYCLE_NEXT_STAGES,
  LIFECYCLE_VERSION,
  LifecycleError,
  RESOLVER_CONFIDENCE,
  VOLUNTARY_REFUND_CONFIDENCE,
  type DeliveryTier,
  type DisputeDecision,
  type FundEscrowInput,
  type LifecycleStage,
  type LifecycleStore,
  type LifecycleTransition,
  type OpenDisputeInput,
  type OpenTransactionInput,
  type RefundEscrowInput,
  type ReleaseEscrowInput,
  type ResolveDisputeInput,
  type StoredLifecycleTransition,
  type TransactionLifecycle,
} from './lifecycle';
export {
  flowLifecycleOutcome,
  type LifecycleFlowResult,
} from './lifecycle-flow';
export type {
  EscrowFundRequest,
  EscrowPort,
  EscrowRefundResult,
  EscrowReleaseResult,
  EscrowSession,
} from './escrow-port';
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
  OUTCOME_BUYER_FAULT,
  OUTCOME_INVOICE,
  OUTCOME_NO_FAULT,
  OUTCOME_SELLER_FAULT,
  OUTCOME_SERVICE,
  TX_INVOICE,
  TX_SERVICE,
  type KycFixtureCase,
} from './fixtures/index';
