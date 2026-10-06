/**
 * @fileoverview Reliability read-route registry. Each lane adds its own
 * route file under services/reliability/ and one line in the routes
 * array below. The control API spreads this table into its demo routes
 * without changing existing behavior.
 */

import {laneARoutes} from './routes-lane-a';
import {plumbingRoutes, type ReliabilityRoute} from './routes-plumbing';

export type {ReliabilityRoute};

/**
 * All reliability read routes. Lane files export their own arrays.
 * Add one entry here per lane file. Plumbing routes stay first.
 */
export const reliabilityRoutes: ReliabilityRoute[] = [
  ...plumbingRoutes,
  ...laneARoutes,
];
