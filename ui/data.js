// GET-only transport. Collection failures preserve a complete last snapshot.

import { isRecord, validateReceipt } from "./model.js"

export async function getJson(path, fetcher = fetch) {
  const response = await fetcher(path, { cache: "no-store", signal: AbortSignal.timeout(2500) })
  if (!response.ok) throw new Error(`${path.split("?")[0]} returned ${response.status}`)
  return response.json()
}

async function optionalJson(path, fetcher) {
  try {
    return { value: await getJson(path, fetcher) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

async function collectKyc(entity, kycById, kycErrors, fetcher) {
  const result = await optionalJson(`/reliability/kyc?entityId=${encodeURIComponent(entity.id)}`, fetcher)
  if (isRecord(result.value) && result.value.entity?.id === entity.id) {
    kycById[entity.id] = result.value
  } else if (result.error && !result.error.endsWith("returned 404")) {
    kycErrors[entity.id] = result.error
  } else if (result.value) {
    kycErrors[entity.id] = "Mock KYC response is malformed"
  }
}

export async function loadMarketplace(fetcher = fetch) {
  const paths = ["entities", "scores", "listings", "transactions"]
  const values = await Promise.all(paths.map(async (name) => {
    const value = await getJson(`/reliability/${name}`, fetcher)
    if (!Array.isArray(value) || !value.every(isRecord)) {
      throw new Error(`/reliability/${name} was not a list of records`)
    }
    return value
  }))
  const [entities, scores, listings, transactions] = values
  const receipts = Object.create(null)
  const receiptErrors = Object.create(null)
  const kycById = Object.create(null)
  const kycErrors = Object.create(null)
  await Promise.all([
    ...transactions.map(async (transaction) => {
      const result = await optionalJson(`/reliability/receipts?transactionId=${encodeURIComponent(transaction.id)}`, fetcher)
      try {
        if (result.error) throw new Error(result.error)
        receipts[transaction.id] = validateReceipt(result.value, transaction.id)
      } catch (error) {
        receiptErrors[transaction.id] = error.message
      }
    }),
    ...entities.map((entity) => collectKyc(entity, kycById, kycErrors, fetcher)),
  ])
  const examples = await optionalJson("/reliability/kyc/fixtures", fetcher)
  return {
    entities, scores, listings, transactions, receipts, receiptErrors, kycById, kycErrors,
    kycExamples: examples.value, kycExamplesError: examples.error,
  }
}

export async function loadTransaction(id, fetcher = fetch) {
  const key = encodeURIComponent(id)
  // Seed receipts do not have durable lifecycle rows. Only a 404 permits
  // the documented fixture receipt fallback.
  const now = encodeURIComponent(new Date().toISOString())
  const response = await fetcher(`/reliability/lifecycle?transactionId=${key}&now=${now}`, {
    cache: "no-store", signal: AbortSignal.timeout(2500),
  })
  if (response.status === 404) {
    return validateReceipt(await getJson(`/reliability/receipts?transactionId=${key}`, fetcher), id)
  }
  if (!response.ok) throw new Error(`Lifecycle returned ${response.status}`)
  const receipt = validateReceipt(await response.json(), id)
  if (!Array.isArray(receipt.entities)) return receipt
  const kycById = Object.create(null)
  const kycErrors = Object.create(null)
  await Promise.all(receipt.entities.map((entity) => collectKyc(entity, kycById, kycErrors, fetcher)))
  return {...receipt, kycById, kycErrors}
}
