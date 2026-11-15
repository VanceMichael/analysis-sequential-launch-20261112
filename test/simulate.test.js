import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compileDesign } from '../src/sequential.js';
import {
  normalizeSimulation, replayTrial, runSimulations, simulateRecords
} from '../src/simulate.js';
import { mulberry32, wilsonInterval } from '../src/normal.js';

const plan = JSON.parse(await readFile('data/plan.json', 'utf8'));
const design = compileDesign(plan);
const baseConfig = normalizeSimulation({ runs: 10 }, plan);

test('同一随机种子产生相同合成记录', () => {
  const first = simulateRecords(plan, baseConfig, mulberry32(123));
  const second = simulateRecords(plan, baseConfig, mulberry32(123));
  assert.deepEqual(first, second);
  const third = simulateRecords(plan, baseConfig, mulberry32(124));
  assert.notDeepEqual(first, third);
});

test('模拟参数可配置且非法值被拒绝', () => {
  assert.deepEqual(normalizeSimulation({ runs: 5, seed: 7 }, plan).runs, 5);
  assert.throws(() => normalizeSimulation({ runs: 0 }, plan), /runs/);
  assert.throws(() => normalizeSimulation({ seed: -1 }, plan), /seed/);
  assert.throws(() => normalizeSimulation({ users: 4 }, plan), /信息量/);
  assert.throws(() => normalizeSimulation({ cap: 500 }, plan), /截尾上限/);
  assert.throws(() => normalizeSimulation({ unknown: 1 }, plan), /未知/);
  assert.equal(baseConfig.cap, plan.outcome.amountCap);
});

test('零效应模拟的误报率接近登记的 alpha', () => {
  const result = runSimulations(plan, design, { runs: 2000, seed: 20261114 });
  assert.ok(result.nullHypothesis);
  assert.ok(result.rejections >= 0);
  // Monte Carlo noise at 2000 runs is roughly sigma = 0.005; allow three
  // standard errors around the preregistered 0.05.
  assert.ok(result.rejectionRate > 0.02 && result.rejectionRate < 0.09,
    `observed ${result.rejectionRate}`);
  assert.ok(result.rejectionInterval.low > 0.015 && result.rejectionInterval.high < 0.10);
  // Unadjusted daily p-values would exceed the sequential rate.
  assert.ok(result.naiveAnyLookRate > result.rejectionRate * 0.5);
});

test('全部观察点都被使用且没有因数据外观提前结束', () => {
  const result = runSimulations(plan, design, { runs: 500, seed: 99 });
  const looksReached = result.runs - result.trialsNotReachingFinalLook;
  assert.ok(looksReached > result.runs * 0.8, `${looksReached} of ${result.runs}`);
  assert.ok(result.stopAtLook['3'] > 0);
});

test('提前停止的例子保留了当时的边界与决定', () => {
  const config = normalizeSimulation({ runs: 1, treatmentMean: 90, seed: 5 }, plan);
  const records = simulateRecords(plan, config, mulberry32(config.seed));
  const outcome = replayTrial(plan, design, records);
  assert.equal(outcome.rejected, true);
  assert.equal(outcome.stoppedAtLook, 1);
  assert.ok(outcome.finalInformation <= Math.round(plan.looks.fractions[0] * plan.information.maxUsers));
});

test('威尔逊区间覆盖点估计并随样本缩小', () => {
  const wide = wilsonInterval(1, 10);
  const narrow = wilsonInterval(1000, 10000);
  assert.ok(wide.low < 0.1 && wide.high > 0.1);
  assert.ok(narrow.high - narrow.low < wide.high - wide.low);
  assert.ok(narrow.center > 0.09 && narrow.center < 0.11);
});
