import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  normalCdf, normalQuantile, normalPdf, erfc, gaussLegendre, mulberry32,
  studentTCdf, studentTQuantile
} from '../src/normal.js';
import {
  compileDesign, solveBoundaries, spendingCumulative, targetUserCount, validatePlan
} from '../src/sequential.js';

const planText = await readFile('data/plan.json', 'utf8');
const basePlan = JSON.parse(planText);

function clonePlan() {
  return JSON.parse(planText);
}

test('正态分布函数在常用分位点保持数值精度', () => {
  const cases = [[0, 0.5], [1, 0.8413447460685429], [-1.959963984540054, 0.025], [2.5758293035489004, 0.995]];
  for (const [x, expected] of cases) {
    assert.ok(Math.abs(normalCdf(x) - expected) < 1e-14, `${x} -> ${normalCdf(x)}`);
    assert.ok(Math.abs(normalCdf(normalQuantile(expected)) - expected) < 1e-12);
  }
  const pdf = normalPdf(0);
  const numeric = (normalCdf(1e-6) - normalCdf(-1e-6)) / 2e-6;
  assert.ok(Math.abs(pdf - numeric) < 1e-9);
});

test('erfc 在两端保持对称与极限', () => {
  assert.ok(Math.abs(erfc(0) - 1) < 1e-15);
  assert.ok(Math.abs(erfc(0.5) - 0.4795001221869535) < 1e-14);
  assert.ok(Math.abs(erfc(-0.5) - (2 - erfc(0.5))) < 1e-15);
  assert.ok(erfc(8) < 1e-27);
});

test('高斯-勒让德节点能精确积分低阶多项式', () => {
  const { nodes, weights } = gaussLegendre(8);
  const integral = weights.reduce((sum, weight, index) => sum + weight * nodes[index] ** 6, 0);
  assert.ok(Math.abs(integral - 2 / 7) < 1e-13);
});

test('种子随机数可复现且位于单位区间', () => {
  const first = mulberry32(83);
  const second = mulberry32(83);
  for (let index = 0; index < 50; index += 1) {
    const value = first();
    assert.equal(value, second());
    assert.ok(value >= 0 && value < 1);
  }
});

test('O’Brien-Fleming 累计消耗随信息增加且最终等于 alpha', () => {
  const design = compileDesign(basePlan);
  const spent = design.cumulativeAlpha;
  assert.equal(spent.length, basePlan.looks.fractions.length);
  for (let index = 1; index < spent.length; index += 1) assert.ok(spent[index] > spent[index - 1]);
  assert.ok(Math.abs(spent[spent.length - 1] - basePlan.alpha) < 1e-12);
  assert.deepEqual(Object.keys(design.spending), ['type']);
});

test('边界由多元正态相关结构求解而非均分 alpha', () => {
  const design = compileDesign(basePlan);
  const { boundaries, correlations, cumulativeAlpha } = design;
  // Correlation matrix of the canonical statistics follows sqrt(f_i/f_j).
  assert.ok(Math.abs(correlations[0][1] - Math.sqrt(0.5 / 0.75)) < 1e-15);
  assert.ok(Math.abs(correlations[1][2] - Math.sqrt(0.75 / 1)) < 1e-15);
  // The naive Bonferroni-style split would give equal per-look hairlines and
  // is measurably different from the solved boundaries.
  const naive = normalQuantile(1 - basePlan.alpha / 2 / boundaries.length);
  assert.ok(boundaries.some(value => Math.abs(value - naive) > 0.2));
  // O’Brien-Fleming gives conservative early looks and a final critical value
  // a little above the nominal normal one because of the finite-sample
  // correction.
  assert.ok(boundaries[0] > boundaries[1] && boundaries[1] > boundaries[2]);
  assert.ok(boundaries[2] > normalQuantile(1 - basePlan.alpha / 2));
  assert.ok(boundaries[2] < normalQuantile(1 - basePlan.alpha / 2) + 0.25);
});

test('边界达到声明的数值精度并可复核', () => {
  const design = compileDesign(basePlan);
  const numerical = design.numerical;
  assert.ok(numerical.boundaryShift < 1e-9, String(numerical.boundaryShift));
  assert.ok(numerical.massError < 1e-9, String(numerical.massError));
  assert.ok(numerical.spendingResidual < 1e-9, String(numerical.spendingResidual));
  assert.ok(Math.abs(numerical.totalAlpha - basePlan.alpha) < 1e-12);
});

test('已知方差模型下的累计交叉概率与登记的 alpha-spending 一致', () => {
  const design = compileDesign(basePlan);
  const cumulative = spendingCumulative(basePlan);
  design.normalModelCrossing.forEach((value, index) => {
    assert.ok(Math.abs(value - cumulative[index]) < 1e-9, `${index}: ${value} vs ${cumulative[index]}`);
  });
});

test('有限样本校正只放大边界且不改变计划信息量', () => {
  const corrected = compileDesign(basePlan);
  const uncorrectedPlan = JSON.parse(planText);
  uncorrectedPlan.numerics.finiteSample = 'none';
  const uncorrected = compileDesign(uncorrectedPlan);
  corrected.boundaries.forEach((value, index) => {
    assert.ok(value > uncorrected.boundaries[index]);
  });
  assert.equal(corrected.numerical.finiteSample.method, 'student-t');
  assert.deepEqual(corrected.fractions, uncorrected.fractions);
  assert.deepEqual(corrected.cumulativeAlpha, uncorrected.cumulativeAlpha);
  const freedoms = corrected.numerical.finiteSample.degreesOfFreedom;
  assert.deepEqual(freedoms, basePlan.looks.fractions.map(f =>
    Math.floor(Math.round(f * basePlan.information.maxUsers) / 2) - 1));
  assert.ok(freedoms.every(value => value > 0));
});

test('student t 分位数与常见表值一致', () => {
  const table = [
    [2, 0.975, 4.3026527297], [5, 0.975, 2.5705818356], [10, 0.995, 3.1692726726],
    [30, 0.975, 2.0422724563], [4, 0.9, 1.5332062741]
  ];
  for (const [df, p, expected] of table) {
    assert.ok(Math.abs(studentTQuantile(p, df) - expected) < 1e-9, `${df} ${p}`);
  }
  assert.ok(Math.abs(studentTCdf(2.086, 20) - 0.975) < 1e-5);
  assert.ok(Math.abs(studentTCdf(0, 7) - 0.5) < 1e-15);
  assert.throws(() => studentTQuantile(0.5, 0), /自由度/);
});

test('Pocock 与 power 设计各产生不同边界', () => {
  const pocock = compileDesign({ ...clonePlan(), spending: { type: 'pocock' } });
  const power = compileDesign({ ...clonePlan(), spending: { type: 'power', gamma: 2 } });
  const obf = compileDesign(basePlan);
  assert.notDeepEqual(pocock.boundaries, obf.boundaries);
  assert.notDeepEqual(power.boundaries, obf.boundaries);
  for (const design of [pocock, power, obf]) {
    assert.ok(Math.abs(design.numerical.totalAlpha - basePlan.alpha) < 1e-12);
  }
});

test('观察点按最大信息量换算为预先登记的用户数', () => {
  assert.deepEqual(basePlan.looks.fractions.map(f => targetUserCount(basePlan.information.maxUsers, f)),
    basePlan.looks.fractions.map(f => Math.round(f * basePlan.information.maxUsers)));
});

test('计划字段被篡改时拒绝编译', () => {
  const bad = clonePlan();
  bad.alpha = 0.5;
  assert.throws(() => validatePlan(bad), /alpha/);
  const unknown = clonePlan();
  unknown.spending = { type: 'obrien-fleming', gamma: 1 };
  assert.throws(() => validatePlan(unknown), /gamma/);
  const fractions = clonePlan();
  fractions.looks.fractions = [0.5, 1];
  fractions.looks.fractions[1] = 0.5;
  assert.throws(() => validatePlan(fractions), /递增/);
  const unit = clonePlan();
  unit.arms.randomizationUnit = 'session';
  assert.throws(() => validatePlan(unit), /user/);
  const extra = clonePlan();
  extra.outcome.field = 'revenue';
  assert.throws(() => validatePlan(extra), /amount/);
  const hidden = clonePlan();
  hidden.looks.fractions = [0.5, 0.75, 0.98];
  assert.throws(() => validatePlan(hidden), /最后/);
});

test('求解器对不同观察点数量都收敛', () => {
  const fractions = [0.2, 0.4, 0.6, 0.8, 1];
  const cumulativeAlpha = fractions.map(f => 2 - 2 * normalCdf(normalQuantile(0.975) / Math.sqrt(f)));
  const result = solveBoundaries({
    fractions, cumulativeAlpha, quadratureOrder: 128, tolerance: 1e-9, maxIterations: 60
  });
  assert.equal(result.boundaries.length, 5);
  assert.ok(result.boundaries.every(value => Number.isFinite(value) && value > 0));
  const expectedFinal = normalQuantile(0.975);
  assert.ok(Math.abs(result.boundaries[4] - expectedFinal) < 0.15);
});
