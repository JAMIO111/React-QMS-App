import { readFileSync } from 'fs';
import { join } from 'path';
import { flattenRecord } from './rest-api.adapter';

/**
 * The contract with the connector agent (AG5c): an internal API read through the agent must flatten each record exactly as this connector does, so a
 * template made from a cloud API works on an agent's and the other way round. The agent's RestTests check the same file.
 */
describe('flattening a record: the contract with the agent (connector-agent/contract/rest-flatten.json)', () => {
  const contract = JSON.parse(readFileSync(join(__dirname, '../../../../../connector-agent/contract/rest-flatten.json'), 'utf8')) as {
    cases: Array<{ record: string; expected: Array<[string, string]> }>;
  };

  it('holds the hard cases', () => {
    expect(contract.cases.length).toBeGreaterThanOrEqual(10);
  });

  it.each(contract.cases.map((c, i) => [i + 1, c] as const))('case %i flattens as the contract says', (_i, c) => {
    expect(Object.entries(flattenRecord(JSON.parse(c.record) as Record<string, unknown>))).toEqual(c.expected);
  });
});
