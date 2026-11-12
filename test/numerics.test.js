import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { summarize } from '../src/domain.js';

const seed = JSON.parse(await readFile('data/records.json', 'utf8')).records[0];
const probe = patches => summarize(patches.map((patch, index) => ({...seed, id: `p${index}`, ...patch}))).groups[0];

test('支付结算金额按用户记录计算均值，零额仍保留', () => {

  assert.equal(probe([{amount: 0}, {amount: 100}]).meanAmount, 50);
  assert.equal(probe([{amount: 0}]).meanAmount, 0);
});
