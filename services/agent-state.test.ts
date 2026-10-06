import {Database} from 'bun:sqlite';
import {describe, expect, test} from 'bun:test';
import {appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {AgentStore} from '../packages/db/src';
import type {Intent, Policy, Portfolio} from '../packages/core/src';
import {start} from './control-api';

type AgentState = {policy: Policy; portfolio: Portfolio};

const post = (origin: string, path: string, body: unknown) => fetch(`${origin}${path}`, {
  method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body),
});
const state = async (origin: string): Promise<AgentState> => {
  const response = await fetch(`${origin}/agent/state`);
  expect(response.status).toBe(200);
  return response.json() as Promise<AgentState>;
};
const order = (key: string, size = 20) => ({
  idempotencyKey: key,
  intent: {venue: 'polymarket', marketId: 'm1', side: 'yes', size, limit: 0.5, reason: 'edge'} satisfies Intent,
});

const withServer = async (run: (context: {
  origin: () => string; restart: () => Promise<void>; databasePath: string; auditFile: string;
}) => Promise<void>) => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-state-'));
  const options = {databasePath: join(directory, 'agent.sqlite'), auditFile: join(directory, 'audit.jsonl')};
  let server = start(0, options);
  try {
    await run({
      ...options,
      origin: () => `http://127.0.0.1:${server.port}`,
      restart: async () => {
        await server.stop(true);
        server = start(0, options);
      },
    });
  } finally {
    await server.stop(true);
    rmSync(directory, {recursive: true, force: true});
  }
};

describe('durable agent state', () => {
  test('recovers an incomplete audit tail without losing the book, completed records, or deduplication', async () => {
    await withServer(async ({origin, restart, auditFile}) => {
      await post(origin(), '/orders', {cycleId: 'buy', orders: [order('buy')]});
      const body = {cycleId: 'completed', events: [{type: 'cycle_end', detail: 'paper fill ✓'}]};
      expect((await post(origin(), '/audit', body)).status).toBe(200);
      const before = await state(origin());
      const audit = await (await fetch(`${origin()}/audit`)).json();
      const completed = readFileSync(auditFile);
      const fragment = Buffer.from('{"cycleId":"interrupted","events":[');
      appendFileSync(auditFile, fragment);
      await restart();
      expect(await state(origin())).toEqual(before);
      expect(await (await fetch(`${origin()}/audit`)).json()).toEqual(audit);
      expect(readFileSync(auditFile)).toEqual(completed);
      const recovered = readdirSync(dirname(auditFile)).filter((file) => file.startsWith('audit.jsonl.incomplete-'));
      expect(recovered).toHaveLength(1);
      expect(readFileSync(join(dirname(auditFile), recovered[0]))).toEqual(fragment);
      expect(await (await post(origin(), '/audit', body)).json()).toMatchObject({duplicate: true});
      expect((await post(origin(), '/audit', {...body, cycleId: 'after-recovery'})).status).toBe(200);
      await restart();
      expect(await (await fetch(`${origin()}/audit`)).json()).toHaveLength(2);
      expect(readdirSync(dirname(auditFile)).filter((file) => file.startsWith('audit.jsonl.incomplete-'))).toEqual(recovered);
    });
  });

  test('retains a complete unterminated audit record and separates the next append', async () => {
    await withServer(async ({origin, restart, auditFile}) => {
      const body = {cycleId: 'unterminated', events: [{type: 'cycle_end', detail: 'done'}]};
      await post(origin(), '/audit', body);
      const original = await (await fetch(`${origin()}/audit`)).json();
      writeFileSync(auditFile, readFileSync(auditFile, 'utf8').trimEnd());
      await restart();
      expect(await (await fetch(`${origin()}/audit`)).json()).toEqual(original);
      expect(await (await post(origin(), '/audit', body)).json()).toMatchObject({duplicate: true});
      expect((await post(origin(), '/audit', {...body, cycleId: 'following'})).status).toBe(200);
      const lines = readFileSync(auditFile, 'utf8').trimEnd().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines.map((line) => JSON.parse(line).cycleId)).toEqual(['unterminated', 'following']);
      await restart();
      expect(await (await fetch(`${origin()}/audit`)).json()).toHaveLength(2);
    });
  });

  test('refuses completed audit corruption and invalid complete records without rewriting the log', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-audit-corrupt-'));
    const auditFile = join(directory, 'audit.jsonl');
    try {
      for (const contents of ['{"corrupt":\n{"interrupted":', '{"invalid":"record"}']) {
        writeFileSync(auditFile, contents);
        expect(() => start(0, {auditFile, databasePath: ':memory:'})).toThrow();
        expect(readFileSync(auditFile, 'utf8')).toBe(contents);
        expect(readdirSync(directory)).toEqual(['audit.jsonl']);
      }
    } finally {
      rmSync(directory, {recursive: true, force: true});
    }
  });

  test('restores policy, positions, risk accounting, audit, and the original fill', async () => {
    await withServer(async ({origin, restart}) => {
      const policy = {max_bet: 40, category_deny: ['politics', 'sports'], venues_enabled: ['polymarket']};
      expect((await post(origin(), '/agent/policy', policy)).status).toBe(200);
      const request = {cycleId: 'cycle-restart', orders: [order('restart:order:0')]};
      const first = await post(origin(), '/orders', request);
      expect(first.status).toBe(200);
      const originalFill = await first.json();
      await post(origin(), '/agent/debug/shock', {pnl: 50});
      await post(origin(), '/agent/debug/shock', {pnl: -40});
      await post(origin(), '/agent/policy', {kill_switch: true});
      const auditBody = {
        cycleId: request.cycleId,
        events: [{type: 'fill_filled', detail: 'paper fill', fill: {mode: 'paper'}}, {type: 'cycle_end', detail: 'done'}],
      };
      expect((await post(origin(), '/audit', auditBody)).status).toBe(200);
      const before = await state(origin());
      expect(before.policy).toMatchObject({...policy, kill_switch: true});
      expect(before.portfolio).toMatchObject({cash: 990, equity: 1010, dailyPnl: 10, highWaterMark: 1050});
      expect(before.portfolio.positions).toHaveLength(1);
      const audit = await (await fetch(`${origin()}/audit`)).json();

      await restart();
      expect(await state(origin())).toEqual(before);
      expect(await (await fetch(`${origin()}/audit`)).json()).toEqual(audit);
      const retry = await post(origin(), '/orders', request);
      expect(await retry.json()).toEqual(originalFill);
      expect(await state(origin())).toEqual(before);
      expect(await (await post(origin(), '/audit', auditBody)).json()).toEqual({ok: true, events: 2, duplicate: true});
      const blocked = await post(origin(), '/orders', {cycleId: 'cycle-blocked', orders: [order('blocked:order:0')]});
      expect(await blocked.json()).toMatchObject({fills: [{status: 'rejected', mode: 'paper', reason: 'kill_switch_on'}]});
      expect(await state(origin())).toEqual(before);
    });
  });

  test('persists rejected fills, then preserves keys and policy through a book reset', async () => {
    await withServer(async ({origin, restart}) => {
      const filledRequest = {cycleId: 'cycle-filled', orders: [order('filled-key')]};
      const filled = await (await post(origin(), '/orders', filledRequest)).json();
      const rejectedRequest = {cycleId: 'cycle-rejected', orders: [order('rejected-key', 2000)]};
      const rejected = await (await post(origin(), '/orders', rejectedRequest)).json();
      expect(rejected).toMatchObject({fills: [{status: 'rejected', reason: 'insufficient_cash'}]});
      await post(origin(), '/agent/policy', {max_bet: 30});
      expect((await post(origin(), '/agent/debug/reset', {})).status).toBe(200);
      await restart();
      const resetState = await state(origin());
      expect(resetState.policy.max_bet).toBe(30);
      expect(resetState.portfolio).toMatchObject({cash: 1000, equity: 1000, highWaterMark: 1000, dailyPnl: 0, positions: []});
      expect(await (await post(origin(), '/orders', filledRequest)).json()).toEqual(filled);
      expect(await (await post(origin(), '/orders', rejectedRequest)).json()).toEqual(rejected);
      expect(await state(origin())).toEqual(resetState);
    });
  });

  test('rolls back every fill and book change when the final database write fails', async () => {
    await withServer(async ({origin, restart, databasePath}) => {
      const before = await state(origin());
      const db = new Database(databasePath);
      try {
        db.run(`CREATE TRIGGER fail_book_write BEFORE UPDATE ON agent_state
          BEGIN SELECT RAISE(ABORT, 'test book write failure'); END`);
        const request = {cycleId: 'cycle-rollback', orders: [order('rollback-0'), order('rollback-1')]};
        const failed = await post(origin(), '/orders', request);
        expect(failed.status).toBe(500);
        await failed.text();
        expect(await state(origin())).toEqual(before);
        const store = AgentStore.open(databasePath);
        try {
          expect(store.getOrder('rollback-0')).toBeUndefined();
          expect(store.getOrder('rollback-1')).toBeUndefined();
          expect(store.getRun(request.cycleId)).toBeUndefined();
        } finally {
          store.close();
        }
        db.run('DROP TRIGGER fail_book_write');
        await restart();
        expect(await state(origin())).toEqual(before);
        const retry = await post(origin(), '/orders', request);
        expect(retry.status).toBe(200);
        const fills = await retry.json();
        expect(fills).toMatchObject({fills: [{status: 'filled'}, {status: 'filled'}]});
        const after = await state(origin());
        expect(after.portfolio.cash).toBe(980);
        expect(after.portfolio.positions).toHaveLength(2);
        await restart();
        expect(await (await post(origin(), '/orders', request)).json()).toEqual(fills);
        expect(await state(origin())).toEqual(after);
      } finally {
        db.close();
      }
    });
  });

  test('rolls back the policy snapshot if saving the active policy fails', async () => {
    await withServer(async ({origin, databasePath}) => {
      const before = await state(origin());
      const db = new Database(databasePath);
      try {
        const count = () => db.query<{count: number}, []>('SELECT COUNT(*) AS count FROM policy').get()!.count;
        const originalCount = count();
        db.run(`CREATE TRIGGER fail_policy_write BEFORE UPDATE ON agent_state
          BEGIN SELECT RAISE(ABORT, 'test policy write failure'); END`);
        const response = await post(origin(), '/agent/policy', {kill_switch: true});
        expect(response.status).toBe(500);
        await response.text();
        expect(await state(origin())).toEqual(before);
        expect(count()).toBe(originalCount);
      } finally {
        db.close();
      }
    });
  });

  test('serializes duplicate and competing requests through separate connections', async () => {
    await withServer(async ({origin, databasePath, auditFile}) => {
      const second = start(0, {databasePath, auditFile});
      const secondOrigin = `http://127.0.0.1:${second.port}`;
      try {
        const request = {cycleId: 'cycle-concurrent', orders: [order('concurrent-key')]};
        const responses = await Promise.all([post(origin(), '/orders', request), post(secondOrigin, '/orders', request)]);
        const bodies = await Promise.all(responses.map((response) => response.json()));
        expect(bodies[0]).toEqual(bodies[1]);
        expect((await state(origin())).portfolio.cash).toBe(990);
        expect((await state(secondOrigin)).portfolio.positions).toHaveLength(1);
        await post(origin(), '/agent/policy', {max_bet: 1000});
        const competing = await Promise.all([
          post(origin(), '/orders', {cycleId: 'compete-0', orders: [order('compete-0', 1200)]}),
          post(secondOrigin, '/orders', {cycleId: 'compete-1', orders: [order('compete-1', 1200)]}),
        ]);
        const outcomes = await Promise.all(competing.map(async (response) => {
          const body = await response.json() as {fills: {status: string}[]};
          return body.fills[0].status;
        }));
        expect(outcomes.sort()).toEqual(['filled', 'rejected']);
        expect((await state(origin())).portfolio.cash).toBe(390);
        expect(await state(secondOrigin)).toEqual(await state(origin()));
      } finally {
        await second.stop(true);
      }
    });
  });

  test('rejects malformed writes before any policy, order, or book mutation', async () => {
    await withServer(async ({origin, databasePath}) => {
      const before = await state(origin());
      for (const policy of [null, {max_bet: -1}, {stop_loss_pct: 2}, {kill_switch: 'false'}, {category_deny: null}, {venues_enabled: ['unknown']}, {unknown: 1}]) {
        const response = await post(origin(), '/agent/policy', policy);
        expect(response.status).toBe(400);
        await response.text();
      }
      for (const badIntent of [null, {...order('bad').intent, size: -1}, {...order('bad').intent, limit: null}, {...order('bad').intent, marketId: ''}]) {
        const response = await post(origin(), '/orders', {
          cycleId: 'invalid-batch', orders: [order('valid-prefix'), {idempotencyKey: 'bad', intent: badIntent}],
        });
        expect(response.status).toBe(400);
        await response.text();
      }
      for (const body of [{pnl: null}, {pnl: '10'}]) {
        const response = await post(origin(), '/agent/debug/shock', body);
        expect(response.status).toBe(400);
        await response.text();
      }
      expect(await state(origin())).toEqual(before);
      const store = AgentStore.open(databasePath);
      try {
        expect(store.getOrder('valid-prefix')).toBeUndefined();
        expect(store.getRun('invalid-batch')).toBeUndefined();
      } finally {
        store.close();
      }
    });
  });

  test('isolates books in different databases instead of sharing module state', async () => {
    await withServer(async ({origin, databasePath, auditFile}) => {
      await post(origin(), '/agent/policy', {kill_switch: true});
      await post(origin(), '/agent/debug/shock', {pnl: -250});
      const second = start(0, {databasePath: `${databasePath}.other`, auditFile: `${auditFile}.other`});
      try {
        const other = await state(`http://127.0.0.1:${second.port}`);
        expect(other.policy.kill_switch).toBe(false);
        expect(other.portfolio.equity).toBe(1000);
        expect((await state(origin())).portfolio.equity).toBe(750);
      } finally {
        await second.stop(true);
      }
    });
  });

  test('fails startup on an unreadable stored book without replacing it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-corrupt-'));
    const options = {databasePath: join(directory, 'agent.sqlite'), auditFile: join(directory, 'audit.jsonl')};
    const server = start(0, options);
    try {
      await post(`http://127.0.0.1:${server.port}`, '/orders', {cycleId: 'before-corruption', orders: [order('saved-key')]});
    } finally {
      await server.stop(true);
    }
    const db = new Database(options.databasePath);
    try {
      const saved = db.query<{positions: string}, []>('SELECT positions_json AS positions FROM agent_state').get()!.positions;
      db.run("UPDATE agent_state SET positions_json = 'broken JSON'");
      expect(() => start(0, options)).toThrow();
      expect(db.query<{cash: number; positions: string}, []>(
        'SELECT cash, positions_json AS positions FROM agent_state',
      ).get()).toEqual({cash: 990, positions: 'broken JSON'});
      db.run('UPDATE agent_state SET positions_json = ?, cash = ?', [saved, 'invalid cash']);
      expect(() => start(0, options)).toThrow('cash must be a finite number');
      expect(db.query<{cash: string}, []>('SELECT cash FROM agent_state').get()!.cash).toBe('invalid cash');
    } finally {
      db.close();
      rmSync(directory, {recursive: true, force: true});
    }
  });

  test('recovers a committed order after the service process is killed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-crash-'));
    const databasePath = join(directory, 'agent.sqlite');
    const auditFile = join(directory, 'audit.jsonl');
    const launch = async () => {
      const script = `import {start} from ${JSON.stringify(new URL('./control-api.ts', import.meta.url).href)};
        const server = start(0, {databasePath: process.env.TEST_AGENT_DB_PATH, auditFile: process.env.TEST_AGENT_AUDIT_FILE});
        console.log(server.port);`;
      const environment = {...process.env};
      environment['TEST_AGENT_DB_PATH'] = databasePath;
      environment['TEST_AGENT_AUDIT_FILE'] = auditFile;
      const child = Bun.spawn([process.execPath, '--eval', script], {
        env: environment,
        stdout: 'pipe', stderr: 'inherit',
      });
      const reader = child.stdout.getReader();
      let output = '';
      try {
        while (!output.includes('\n')) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error(`service exited before startup: ${await child.exited}`);
          output += new TextDecoder().decode(chunk.value);
        }
      } catch (error) {
        child.kill();
        await child.exited;
        throw error;
      } finally {
        reader.releaseLock();
      }
      return {child, origin: `http://127.0.0.1:${Number(output.split('\n')[0])}`};
    };
    let service: Awaited<ReturnType<typeof launch>> | undefined;
    try {
      service = await launch();
      const request = {cycleId: 'cycle-crash', orders: [order('crash-key')]};
      const filled = await (await post(service.origin, '/orders', request)).json();
      await post(service.origin, '/agent/policy', {category_deny: ['sports']});
      const before = await state(service.origin);
      service.child.kill('SIGKILL');
      await service.child.exited;
      service = await launch();
      expect(await state(service.origin)).toEqual(before);
      expect(await (await post(service.origin, '/orders', request)).json()).toEqual(filled);
      expect(await state(service.origin)).toEqual(before);
    } finally {
      if (service) {
        service.child.kill();
        await service.child.exited;
      }
      rmSync(directory, {recursive: true, force: true});
    }
  });
});
