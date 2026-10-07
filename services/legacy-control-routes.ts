/**
 * @fileoverview Compatibility routes for the retired paper trading demo.
 */

import {markPositions} from '../packages/core/src/portfolio';
import type {AgentStore} from '../packages/db/src';
import {
  AgentRequestError, createAgentRuntime, type AgentRuntimeOptions,
} from './agent-runtime';
import {json, readJson, type Handler, type Routes} from './lib/http';

/** Registers the paper trading demo against a store owned by the control API. */
export function createLegacyControlRoutes(
  store: AgentStore, options: AgentRuntimeOptions,
): Routes {
  const runtime = createAgentRuntime({...options, store});
  const handle = (handler: Handler): Handler => async (request, url) => {
    try {
      return await handler(request, url);
    } catch (error) {
      if (error instanceof AgentRequestError) return json({error: error.message}, error.status);
      if (error instanceof SyntaxError) return json({error: 'invalid JSON'}, 400);
      throw error;
    }
  };
  return {
    'GET /agent/state': handle(() => json(runtime.state())),
    'POST /agent/marks': handle(async (request) =>
      json({portfolio: runtime.updateQuotes(await readJson<unknown>(request))})),
    'POST /positions/close': handle(async (request) =>
      json(runtime.closePosition(await readJson<unknown>(request)))),
    'POST /markets/resolve': handle(async (request) =>
      json(runtime.resolveMarket(await readJson<unknown>(request)))),
    'GET /positions/history': () => json(runtime.history()),
    'GET /agent/days': handle(() => json(runtime.days())),
    'POST /agent/policy': handle(async (request) =>
      json({policy: runtime.updatePolicy(await readJson<unknown>(request))})),
    'POST /agent/debug/shock': handle(async (request) =>
      json({portfolio: runtime.shock(await readJson<unknown>(request))})),
    'POST /agent/debug/reset': () => json({portfolio: runtime.reset()}),
    'POST /orders': handle(async (request) =>
      json(runtime.submitOrders(await readJson<unknown>(request)))),
  };
}

/** Reads an existing paper book without creating a runtime or changing its state. */
export function createStoredAgentReadRoutes(store: AgentStore): Routes {
  return {
    'GET /agent/state': () => {
      const state = store.getAgentState();
      if (!state) return json({error: 'no stored legacy agent state'}, 404);
      const policy = store.getPolicy(state.policyId);
      if (!policy) throw new Error('stored policy is missing');
      const positions = markPositions(state.portfolio.positions, store.listMarketQuotes(), Date.now(), 90_000);
      return json({
        policy: policy.policy,
        portfolio: {
          ...state.portfolio, ...state.accounting, positions,
          unrealizedPnl: positions.reduce((sum, position) => sum + position.unrealizedPnl, 0),
        },
        quoteSource: {status: 'disabled', errors: []},
      });
    },
  };
}
