/**
 * @fileoverview KYC profile and status history rows.
 * Domain behavior lives in packages/reliability/src/kyc.ts.
 * This module only stores and reads rows.
 */

import type {Database} from 'bun:sqlite';
import {
  KYC_BADGES as BADGES,
  KYC_HOWS as HOWS,
  KYC_RE_REGISTRATION_SIGNALS as SIGNALS,
  type KycProfile,
  type KycStatusRecord,
  type KycSubjectKind,
} from '../../reliability/src/kyc';
import type {Entity, KycStatus, KycTier} from '../../reliability/src/types';
import {
  bindOptionalText, jsonText, requireOneOf, requiredRow, requireText,
} from './codecs';
import {getEntity} from './reliability';

const KINDS: readonly KycSubjectKind[] = ['person', 'business'];
const STATUSES: readonly KycStatus[] = [
  'unverified', 'pending', 'verified', 'rejected',
];
const TIERS: readonly KycTier[] = ['none', 'basic', 'enhanced'];

/** Updates the frozen KYC status and tier. Wallets and roles stay. */
export function updateEntityKyc(
  db: Database, id: string, status: KycStatus, tier: KycTier,
): Entity {
  const result = db.query(
    `UPDATE reliability_entities SET kyc_status = ?, kyc_tier = ? WHERE id = ?`,
  ).run(
    requireOneOf(status, STATUSES, 'kycStatus'),
    requireOneOf(tier, TIERS, 'kycTier'),
    requireText(id, 'entity id'),
  );
  if (result.changes === 0) throw new Error('entity was not stored');
  return requiredRow(getEntity(db, id), 'entity');
}

/** Returns the entity that owns a wallet, or undefined. */
export function getWalletEntityId(
  db: Database, wallet: string,
): string|undefined {
  const row = db.query<{entityId: string}, [string]>(
    `SELECT entity_id AS entityId FROM reliability_wallets WHERE wallet = ?`,
  ).get(requireText(wallet, 'wallet'));
  return row?.entityId;
}

interface ProfileRow {
  entityId: string;
  subjectKind: string;
  documentId: string|null;
  registrationNumber: string|null;
  beneficialOwnerDocumentId: string|null;
  checksJson: string;
  reRegistrationOf: string|null;
  reRegistrationSignal: string|null;
  reRegistrationValue: string|null;
  rulesVersion: string;
  verifiedAt: string|null;
  pendingSince: string|null;
  updatedAt: string;
}

const SELECT_PROFILE = `SELECT
  entity_id AS entityId, subject_kind AS subjectKind,
  document_id AS documentId, registration_number AS registrationNumber,
  beneficial_owner_document_id AS beneficialOwnerDocumentId,
  checks_json AS checksJson, re_registration_of AS reRegistrationOf,
  re_registration_signal AS reRegistrationSignal,
  re_registration_value AS reRegistrationValue,
  rules_version AS rulesVersion, verified_at AS verifiedAt,
  pending_since AS pendingSince,
  updated_at AS updatedAt
  FROM reliability_kyc_profiles`;

function parseProfile(row: ProfileRow): KycProfile {
  const signal = row.reRegistrationSignal === null ?
    undefined :
    requireOneOf(row.reRegistrationSignal, SIGNALS, 'reRegistrationSignal');
  return {
    entityId: requireText(row.entityId, 'entityId'),
    subjectKind: requireOneOf(row.subjectKind, KINDS, 'subjectKind'),
    documentId: optionalText(row.documentId),
    registrationNumber: optionalText(row.registrationNumber),
    beneficialOwnerDocumentId: optionalText(row.beneficialOwnerDocumentId),
    submittedChecks: parseChecks(row.checksJson),
    reRegistrationOf: optionalText(row.reRegistrationOf),
    reRegistrationSignal: signal,
    reRegistrationValue: optionalText(row.reRegistrationValue),
    rulesVersion: requireText(row.rulesVersion, 'rulesVersion'),
    verifiedAt: optionalText(row.verifiedAt),
    pendingSince: optionalText(row.pendingSince),
    updatedAt: requireText(row.updatedAt, 'updatedAt'),
  };
}

/** Inserts or replaces the KYC profile for one entity. */
export function saveKycProfile(db: Database, profile: KycProfile): KycProfile {
  db.query(`INSERT INTO reliability_kyc_profiles (
      entity_id, subject_kind, document_id, registration_number,
      beneficial_owner_document_id, checks_json, re_registration_of,
      re_registration_signal, re_registration_value, rules_version,
      verified_at, pending_since, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (entity_id) DO UPDATE SET
      subject_kind = excluded.subject_kind,
      document_id = excluded.document_id,
      registration_number = excluded.registration_number,
      beneficial_owner_document_id = excluded.beneficial_owner_document_id,
      checks_json = excluded.checks_json,
      re_registration_of = excluded.re_registration_of,
      re_registration_signal = excluded.re_registration_signal,
      re_registration_value = excluded.re_registration_value,
      rules_version = excluded.rules_version,
      verified_at = excluded.verified_at,
      pending_since = excluded.pending_since,
      updated_at = excluded.updated_at`).run(
    requireText(profile.entityId, 'entityId'),
    requireOneOf(profile.subjectKind, KINDS, 'subjectKind'),
    bindOptionalText(profile.documentId),
    bindOptionalText(profile.registrationNumber),
    bindOptionalText(profile.beneficialOwnerDocumentId),
    jsonText([...profile.submittedChecks]),
    bindOptionalText(profile.reRegistrationOf),
    profile.reRegistrationSignal === undefined ?
      null :
      requireOneOf(profile.reRegistrationSignal, SIGNALS, 'reRegistrationSignal'),
    bindOptionalText(profile.reRegistrationValue),
    requireText(profile.rulesVersion, 'rulesVersion'),
    bindOptionalText(profile.verifiedAt),
    bindOptionalText(profile.pendingSince),
    requireText(profile.updatedAt, 'updatedAt'),
  );
  return requiredRow(getKycProfile(db, profile.entityId), 'kyc profile');
}

/** Returns the profile, or undefined when the entity has none. */
export function getKycProfile(
  db: Database, entityId: string,
): KycProfile|undefined {
  const row = db.query<ProfileRow, [string]>(
    `${SELECT_PROFILE} WHERE entity_id = ?`,
  ).get(entityId);
  if (!row) return undefined;
  return parseProfile(row);
}

/**
 * Profiles whose mocked document or beneficial owner document matches.
 * Ordered by entity id.
 */
export function listKycProfilesByDocument(
  db: Database, documentId: string,
): KycProfile[] {
  return db.query<ProfileRow, [string, string]>(
    `${SELECT_PROFILE}
     WHERE document_id = ? OR beneficial_owner_document_id = ?
     ORDER BY entity_id`,
  ).all(
    requireText(documentId, 'documentId'),
    requireText(documentId, 'documentId'),
  ).map(parseProfile);
}

/** Profiles with this registration number, ordered by entity id. */
export function listKycProfilesByRegistration(
  db: Database, registrationNumber: string,
): KycProfile[] {
  return db.query<ProfileRow, [string]>(
    `${SELECT_PROFILE} WHERE registration_number = ? ORDER BY entity_id`,
  ).all(requireText(registrationNumber, 'registrationNumber')).map(parseProfile);
}

interface StatusRow {
  id: string;
  entityId: string;
  status: string;
  tier: string;
  badge: string;
  how: string;
  detailJson: string;
  provider: string;
  rulesVersion: string;
  at: string;
}

/** Appends one status record. Ids are unique. */
export function insertKycStatusRecord(
  db: Database, record: KycStatusRecord,
): void {
  db.query(`INSERT INTO reliability_kyc_status_records (
      id, entity_id, status, tier, badge, how, detail_json, provider,
      rules_version, at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    requireText(record.id, 'kyc record id'),
    requireText(record.entityId, 'entityId'),
    requireOneOf(record.status, STATUSES, 'kycStatus'),
    requireOneOf(record.tier, TIERS, 'kycTier'),
    requireOneOf(record.badge, BADGES, 'badge'),
    requireOneOf(record.how, HOWS, 'how'),
    jsonText(record.detail),
    requireText(record.provider, 'provider'),
    requireText(record.rulesVersion, 'rulesVersion'),
    requireText(record.at, 'at'),
  );
}

/** Status records for one entity, in the order they were saved. */
export function listKycStatusRecords(
  db: Database, entityId: string,
): KycStatusRecord[] {
  return db.query<StatusRow, [string]>(`SELECT
      id, entity_id AS entityId, status, tier, badge, how,
      detail_json AS detailJson, provider, rules_version AS rulesVersion, at
      FROM reliability_kyc_status_records
      WHERE entity_id = ? ORDER BY rowid`).all(entityId).map(parseStatus);
}

function parseStatus(row: StatusRow): KycStatusRecord {
  return {
    id: requireText(row.id, 'kyc record id'),
    entityId: requireText(row.entityId, 'entityId'),
    status: requireOneOf(row.status, STATUSES, 'kycStatus'),
    tier: requireOneOf(row.tier, TIERS, 'kycTier'),
    badge: requireOneOf(row.badge, BADGES, 'badge'),
    how: requireOneOf(row.how, HOWS, 'how'),
    at: requireText(row.at, 'at'),
    provider: requireText(row.provider, 'provider'),
    rulesVersion: requireText(row.rulesVersion, 'rulesVersion'),
    detail: parseDetail(row.detailJson),
  };
}

function parseChecks(raw: string): string[] {
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error('checks must be a list');
  const checks: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '') {
      throw new Error('checks must be a list of strings');
    }
    checks.push(entry);
  }
  return checks;
}

function parseDetail(raw: string): {[key: string]: string} {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('detail must be an object');
  }
  const detail: {[key: string]: string} = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      throw new Error('detail values must be strings');
    }
    detail[key] = entry;
  }
  return detail;
}

function optionalText(value: string|null): string|undefined {
  if (value === null) return undefined;
  return requireText(value, 'optional text');
}
