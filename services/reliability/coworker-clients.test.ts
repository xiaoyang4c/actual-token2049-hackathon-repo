import {describe, expect, test} from 'bun:test';
import {MpsError, MpsSeller} from './mps-seller';
import {CoreError, SokosumiCore} from './sokosumi-core';

function responding(status: number, body: string): typeof fetch {
  return (async () => new Response(body, {status})) as unknown as typeof fetch;
}

describe('Coworker clients: uncertain writes', () => {
  for (const status of [408, 500, 502, 503, 504]) {
    test(`Core treats HTTP ${status} as an uncertain event write`, async () => {
      const core = new SokosumiCore('coworker_test', {fetch: responding(status, '{}')});
      try {
        await core.postEvent('task-1', {status: 'COMPLETED'});
        throw new Error('expected CoreError');
      } catch (error) {
        expect(error).toBeInstanceOf(CoreError);
        expect((error as CoreError).uncertain).toBe(true);
      }
    });

    test(`MPS treats HTTP ${status} as an uncertain result write`, async () => {
      const mps = new MpsSeller('test-token', {fetch: responding(status, '{}')});
      try {
        await mps.submitResult('payment-1', 'a'.repeat(64));
        throw new Error('expected MpsError');
      } catch (error) {
        expect(error).toBeInstanceOf(MpsError);
        expect((error as MpsError).uncertain).toBe(true);
      }
    });
  }

  test('a malformed success response leaves an MPS write uncertain', async () => {
    const mps = new MpsSeller('test-token', {fetch: responding(200, '{"data":{}}')});
    try {
      await mps.submitResult('payment-1', 'a'.repeat(64));
      throw new Error('expected MpsError');
    } catch (error) {
      expect(error).toBeInstanceOf(MpsError);
      expect((error as MpsError).uncertain).toBe(true);
    }
  });

  test('an HTTP 400 rejection is definite for both clients', async () => {
    const fetcher = responding(400, '{}');
    const core = new SokosumiCore('coworker_test', {fetch: fetcher});
    const mps = new MpsSeller('test-token', {fetch: fetcher});
    await expect(core.postEvent('task-1', {status: 'COMPLETED'})).rejects.toMatchObject({uncertain: false});
    await expect(mps.submitResult('payment-1', 'a'.repeat(64))).rejects.toMatchObject({uncertain: false});
  });
});
