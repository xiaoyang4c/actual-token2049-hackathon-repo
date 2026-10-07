import {afterAll, beforeAll, describe, expect, mock, test} from 'bun:test'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {renderToStaticMarkup} from 'react-dom/server'
import {MemoryRouter, Route, Routes} from 'react-router-dom'
import {AgentStore} from '../../packages/db/src'
import {seedShowcase} from '../../services/reliability/contract-showcase'
import {reliabilityRoutes} from '../../services/reliability'
import type {ContractSummary, ContractView} from '../src/lib/api'

const directory = mkdtempSync(join(tmpdir(), 'pr26-contract-page-'))
const responses = new Map<string, unknown>()
const views = new Map<string, ContractView>()
const routes = new Map(reliabilityRoutes.filter((route) => route.method === 'GET').map((route) => [route.path, route]))
let store: AgentStore | undefined
let contracts: ContractSummary[] = []

// Supply actual read-route responses to the page after its loaders finish.
mock.module('../src/lib/useAsync', () => ({
  useAsync(_load: unknown, key: string) {
    if (!responses.has(key)) throw new Error(`No response for ${key}`)
    return {data: responses.get(key), error: null, loading: false, reload: () => {}}
  },
}))

const {ContractPage} = await import('../src/pages/Contract')
const {TooltipProvider} = await import('../src/components/ui/tooltip')

async function read<T>(path: string): Promise<T> {
  const url = new URL(path, 'http://localhost')
  const route = routes.get(url.pathname)
  if (!route || !store) throw new Error(`Read route is unavailable: ${path}`)
  const response = await route.handler(new Request(url), url, store)
  if (!response.ok) throw new Error(await response.text())
  return await response.json() as T
}

// The engine-backed paper fixtures can take more than five seconds on CI.
beforeAll(async () => {
  const database = join(directory, 'agent.sqlite')
  await seedShowcase(database)
  store = AgentStore.open(database)
  contracts = await read<ContractSummary[]>('/reliability/contracts/list')
  responses.set('contracts-all', contracts)
  for (const contract of contracts) {
    const id = contract.id
    const view = await read<ContractView>(`/reliability/contracts?id=${id}`)
    views.set(id, view)
    responses.set(`view-${id}`, view)
    responses.set(`case-${id}`, await read(`/reliability/contracts/case?id=${id}&milestone=0`))
    responses.set(`audit-${id}`, await read(`/reliability/contracts/audit?id=${id}`))
    responses.set(`anchors-${id}`, await read(`/reliability/anchors/contract?id=${id}`))
  }
}, 30_000)

afterAll(() => {
  store?.close()
  rmSync(directory, {recursive: true, force: true})
})

function render(contract: ContractSummary): string {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/contracts/${contract.id}`]}>
      <TooltipProvider>
        <Routes>
          <Route path="/contracts/:id" element={<ContractPage />} />
        </Routes>
      </TooltipProvider>
    </MemoryRouter>,
  )
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
}

function withOutcome(state: string): ContractSummary[] {
  return contracts.filter((contract) => views.get(contract.id)?.milestones[0].reliability?.state === state)
}

describe('contract page with actual paper API responses', () => {
  test('renders pending records when the API omits fault', () => {
    const pending = withOutcome('pending')
    expect(pending.length).toBeGreaterThan(0)
    for (const contract of pending) {
      expect(views.get(contract.id)?.milestones[0].reliability?.fault).toBeUndefined()
      expect(render(contract)).toContain('At fault None')
    }
  })

  test('renders a successful record without inventing a party at fault', () => {
    const successful = withOutcome('successful')
    expect(successful).toHaveLength(1)
    const contract = successful[0]
    expect(views.get(contract.id)?.milestones[0].reliability?.fault).toBeUndefined()
    const text = render(contract)
    expect(text).toContain('At fault None')
    expect(text).toContain('recorded as successful')
    expect(text).not.toContain('undefined')
    expect(text).not.toMatch(/with the \w+ at fault/)
  })

  test('preserves the party named in a failed record', () => {
    const failed = withOutcome('failed')
    expect(failed).toHaveLength(1)
    expect(render(failed[0])).toContain('At fault Seller')
    expect(render(failed[0])).toContain('with the seller at fault')
  })

  test('renders all six showcase contract pages', () => {
    expect(contracts).toHaveLength(6)
    for (const contract of contracts) {
      expect(render(contract)).toContain(contract.milestones[0].title)
    }
  })
})
