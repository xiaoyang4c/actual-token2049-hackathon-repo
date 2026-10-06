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
  MOCK_KYC_PROVIDER_NAME,
  MockKycProvider,
  type KycProvider,
  type KycResult,
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
} from './fixtures/index';
