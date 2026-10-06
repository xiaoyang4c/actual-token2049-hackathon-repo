/**
 * @fileoverview Contract templates. A template is configuration: a new
 * transaction type is a new JSON file in templates/, if the engine
 * supports its judge type. Templates with other judge types stay
 * `design_only`.
 */

import {readdirSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {ContractCategory, ContractTemplate} from './types';

const CATEGORIES: readonly ContractCategory[] = [
  'digital_machine_checkable', 'digital_subjective', 'physical_objective_spec',
  'physical_subjective', 'ongoing_service',
];

/** Judge types the engine can run today. */
export const SUPPORTED_JUDGES: ReadonlySet<string> = new Set(['code', 'signed_report']);

const WINDOW_KEYS = [
  'fundingWindowMs', 'deliveryWindowMs', 'inspectionWindowMs',
  'disputeResolutionWindowMs', 'tier1WindowMs', 'tier2WindowMs',
  'tier3WindowMs', 'returnWindowMs', 'redoWindowMs', 'redoInspectionWindowMs',
  'rulingComplianceWindowMs',
] as const;

/** The templates shipped with this package. */
export const DEFAULT_TEMPLATES_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), 'templates');

export class TemplateRegistry {
  private readonly byId = new Map<string, ContractTemplate>();

  static fromDirectory(directory = DEFAULT_TEMPLATES_DIRECTORY): TemplateRegistry {
    const registry = new TemplateRegistry();
    for (const name of readdirSync(directory).filter((file) => file.endsWith('.json')).sort()) {
      registry.add(JSON.parse(readFileSync(join(directory, name), 'utf8')) as ContractTemplate, name);
    }
    return registry;
  }

  add(template: ContractTemplate, source = template.id): void {
    const problems = templateProblems(template);
    if (problems.length > 0) throw new Error(`invalid template ${source}: ${problems.join('; ')}`);
    if (this.byId.has(template.id)) throw new Error(`duplicate template id ${template.id}`);
    this.byId.set(template.id, template);
  }

  get(id: string): ContractTemplate|undefined {
    return this.byId.get(id);
  }

  list(): ContractTemplate[] {
    return [...this.byId.values()];
  }
}

function templateProblems(template: ContractTemplate): string[] {
  const problems: string[] = [];
  if (!template.id || !Number.isInteger(template.version) || template.version < 1) {
    problems.push('id and a positive integer version are required');
  }
  if (!CATEGORIES.includes(template.category)) problems.push(`unknown category ${template.category}`);
  if (template.transactionType !== 'goods' && template.transactionType !== 'service') {
    problems.push('transactionType must be goods or service');
  }
  for (const key of WINDOW_KEYS) {
    const value = template.windows?.[key];
    if (!Number.isSafeInteger(value) || value <= 0) problems.push(`windows.${key} must be a positive integer in ms`);
  }
  if (!template.remedy?.allowed?.includes(template.remedy.default.type)) {
    problems.push('remedy.default must be in remedy.allowed');
  }
  if (template.status === 'enabled' && !SUPPORTED_JUDGES.has(template.judge?.type)) {
    problems.push(`judge type ${template.judge?.type} cannot run yet; mark the template design_only`);
  }
  if (!template.dispute?.tiers?.length) problems.push('dispute.tiers must list at least one tier');
  if (template.judge?.type === 'code' && !template.dispute.tiers.includes(2)) {
    problems.push('the code judge rules at Tier 2; include tier 2');
  }
  for (const value of Object.values(template.fees?.perTierAtomic ?? {})) {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) problems.push('fees.perTierAtomic values must be atomic integer strings');
  }
  return problems;
}

interface PropertySchema {
  type?: 'string'|'number'|'integer'|'boolean';
  pattern?: string;
  minimum?: number;
}

interface ObjectSchema {
  required?: string[];
  properties?: {[key: string]: PropertySchema};
  additionalProperties?: boolean;
}

/** Validates a deliverable against the template's JSON Schema subset. */
export function deliverableProblems(value: unknown, schema: {[key: string]: unknown}): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['must be an object'];
  const spec = schema as ObjectSchema;
  const record = value as {[key: string]: unknown};
  const problems: string[] = [];
  for (const key of spec.required ?? []) {
    if (!(key in record)) problems.push(`missing required field "${key}"`);
  }
  const properties = spec.properties ?? {};
  for (const [key, item] of Object.entries(record)) {
    const property = properties[key];
    if (!property) {
      if (spec.additionalProperties === false) problems.push(`unexpected field "${key}"`);
      continue;
    }
    if (property.type === 'string' && typeof item !== 'string') problems.push(`"${key}" must be a string`);
    if (property.type === 'number' && typeof item !== 'number') problems.push(`"${key}" must be a number`);
    if (property.type === 'integer' && !Number.isInteger(item)) problems.push(`"${key}" must be an integer`);
    if (property.type === 'boolean' && typeof item !== 'boolean') problems.push(`"${key}" must be a boolean`);
    if (property.pattern && typeof item === 'string' && !new RegExp(property.pattern).test(item)) {
      problems.push(`"${key}" does not match ${property.pattern}`);
    }
    if (property.minimum !== undefined && typeof item === 'number' && item < property.minimum) {
      problems.push(`"${key}" must be at least ${property.minimum}`);
    }
  }
  return problems;
}
