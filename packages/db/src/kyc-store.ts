/**
 * @fileoverview Adapts AgentStore to the KYC record seam.
 * The mock provider calls these accessors. It does not open SQLite.
 */

import type {KycRecordStore} from '../../reliability/src/kyc';
import type {AgentStore} from './store';

/** Binds KYC reads and writes to one AgentStore. */
export function kycRecordStore(store: AgentStore): KycRecordStore {
  return {
    transaction: <T>(work: () => T): T => store.transaction(work),
    insertEntity: (entity) => store.insertEntity(entity),
    getEntity: (id) => store.getEntity(id),
    updateEntityKyc: (id, status, tier) => store.updateEntityKyc(id, status, tier),
    addWallet: (entityId, wallet, addedAt) => {
      store.addWallet(entityId, wallet, addedAt);
    },
    getWalletEntityId: (wallet) => store.getWalletEntityId(wallet),
    saveKycProfile: (profile) => store.saveKycProfile(profile),
    getKycProfile: (entityId) => store.getKycProfile(entityId),
    listKycProfilesByDocument: (documentId) => (
      store.listKycProfilesByDocument(documentId)
    ),
    listKycProfilesByRegistration: (registrationNumber) => (
      store.listKycProfilesByRegistration(registrationNumber)
    ),
    insertKycStatusRecord: (record) => {
      store.insertKycStatusRecord(record);
    },
    listKycStatusRecords: (entityId) => store.listKycStatusRecords(entityId),
  };
}
