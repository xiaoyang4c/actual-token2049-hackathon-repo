/**
 * @fileoverview Route contract shared by all reliability lanes.
 */

import type {AgentStore} from '../../packages/db/src/index';
import type {Handler} from '../lib/http';

/** One reliability route. The control API passes its shared store. */
export interface ReliabilityRoute {
  method: string;
  path: string;
  handler: (
    request: Request, url: URL, store: AgentStore,
  ) => ReturnType<Handler>;
}
