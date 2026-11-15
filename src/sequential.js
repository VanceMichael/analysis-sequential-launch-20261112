import { erfc, normalCdf, normalQuantile, gaussLegendre, studentTQuantile } from './normal.js';

// Preregistered design compilation. Everything in this module is a pure
// function of the plan; no outcome data is read here.

const ROOT_KEYS = new Set([
  'version', 'id', 'alpha', 'sides', 'outcome', 'arms', 'information', 'looks', 'spending', 'numerics'
]);
const OUTCOME_KEYS = new Set(['field', 'amountCap', 'perUserAggregation']);
const ARMS_KEYS = new Set(['control', 'treatment', 'randomizationUnit', 'allocation']);
const INFORMATION_KEYS = new Set(['rule', 'maxUsers']);
const LOOKS_KEYS = new Set(['fractions']);
const SPENDING_KEYS = new Set(['type', 'gamma']);
const NUMERICS_KEYS = new Set([
  'quadratureOrder', 'comparisonOrder', 'tolerance', 'maxIterations', 'finiteSample'
]);

function fail(message) {
  throw new Error(message);
}

function requireKeys(object, allowed, label) {
  if (object === null || typeof object !== 'object' || Array.isArray(object)) {
    fail(`${label} 必须是对象`);
  }
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) fail(`${label} 包含未知字段 ${key}`);
  }
}

function requireNumber(value, label, { min = -Infinity, max = Infinity, inclusiveMin = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} 必须是有限数值`);
  if (inclusiveMin ? value < min : value <= min) fail(`${label} 必须大于${inclusiveMin ? '等于' : ''} ${min}`);
  if (value > max) fail(`${label} 必须小于等于 ${max}`);
  return value;
}

export function validatePlan(input) {
  requireKeys(input, ROOT_KEYS, '计划');
  if (input.version !== 1) fail('不支持的实验计划版本');
  if (typeof input.id !== 'string' || input.id.length === 0) fail('计划 id 不能为空');
  requireNumber(input.alpha, 'alpha', { min: 0, max: 0.5, inclusiveMin: false });
  if (!(input.alpha < 0.5)) fail('alpha 必须小于 0.5');
  if (input.sides !== 2) fail('当前只支持双侧设计');

  requireKeys(input.outcome, OUTCOME_KEYS, 'outcome');
  if (input.outcome.field !== 'amount') fail('结局字段必须为 amount');
  requireNumber(input.outcome.amountCap, 'outcome.amountCap', { min: 0 });
  if (!['sum-then-cap', 'cap-each-then-sum'].includes(input.outcome.perUserAggregation)) {
    fail('outcome.perUserAggregation 必须为 sum-then-cap 或 cap-each-then-sum');
  }

  requireKeys(input.arms, ARMS_KEYS, 'arms');
  for (const name of ['control', 'treatment']) {
    if (typeof input.arms[name] !== 'string' || input.arms[name].length === 0) {
      fail(`arms.${name} 不能为空`);
    }
  }
  if (input.arms.control === input.arms.treatment) fail('对照与实验组不能相同');
  if (input.arms.randomizationUnit !== 'user') fail('随机化单位必须为 user');
  if (!Array.isArray(input.arms.allocation) || input.arms.allocation.length !== 2) {
    fail('arms.allocation 必须为两个比例');
  }
  input.arms.allocation.forEach((share, index) => requireNumber(share, `arms.allocation[${index}]`, { min: 0 }));
  if (Math.abs(input.arms.allocation[0] + input.arms.allocation[1] - 1) > 1e-12) {
    fail('arms.allocation 之和必须为 1');
  }

  requireKeys(input.information, INFORMATION_KEYS, 'information');
  if (input.information.rule !== 'eligible-users') fail('information.rule 必须为 eligible-users');
  if (!Number.isSafeInteger(input.information.maxUsers) || input.information.maxUsers < 4) {
    fail('information.maxUsers 必须是至少为 4 的整数');
  }

  requireKeys(input.looks, LOOKS_KEYS, 'looks');
  const fractions = input.looks.fractions;
  if (!Array.isArray(fractions) || fractions.length < 1) fail('looks.fractions 不能为空');
  fractions.forEach((fraction, index) => {
    requireNumber(fraction, `looks.fractions[${index}]`, { min: 0, max: 1 });
    if (index > 0 && fraction <= fractions[index - 1]) fail('观察比例必须严格递增');
  });
  if (fractions[fractions.length - 1] !== 1) fail('最后一个观察比例必须为 1');
  for (let index = 0; index < fractions.length; index += 1) {
    const target = Math.round(fractions[index] * input.information.maxUsers);
    if (target < 4) fail('每个观察点的目标用户数至少为 4');
    if (target <= (index === 0 ? 0 : Math.round(fractions[index - 1] * input.information.maxUsers))) {
      fail('相邻观察点的目标用户数必须严格增加');
    }
    if (target > input.information.maxUsers) fail('观察点目标用户数不能超过最大信息量');
  }

  requireKeys(input.spending, SPENDING_KEYS, 'spending');
  if (!['obrien-fleming', 'pocock', 'power'].includes(input.spending.type)) {
    fail('spending.type 必须为 obrien-fleming、pocock 或 power');
  }
  if (input.spending.type === 'power') {
    requireNumber(input.spending.gamma, 'spending.gamma', { min: 0, max: 10 });
    if (!(input.spending.gamma > 0)) fail('power 设计的 spending.gamma 必须大于 0');
  } else if (input.spending.gamma !== undefined) {
    fail('只有 power 设计可以设置 spending.gamma');
  }

  requireKeys(input.numerics, NUMERICS_KEYS, 'numerics');
  const numerics = input.numerics;
  if (!Number.isSafeInteger(numerics.quadratureOrder) || numerics.quadratureOrder < 16 ||
    numerics.quadratureOrder > 4096) fail('numerics.quadratureOrder 必须是 16..4096 的整数');
  if (!Number.isSafeInteger(numerics.comparisonOrder) || numerics.comparisonOrder < 16 ||
    numerics.comparisonOrder > 4096) fail('numerics.comparisonOrder 必须是 16..4096 的整数');
  if (numerics.quadratureOrder + numerics.comparisonOrder > 4096) {
    fail('复核积分阶数与基础阶数之和不得超过 4096');
  }
  requireNumber(numerics.tolerance, 'numerics.tolerance', { min: 0, max: 1e-4 });
  if (!Number.isSafeInteger(numerics.maxIterations) || numerics.maxIterations < 20 ||
    numerics.maxIterations > 10000) fail('numerics.maxIterations 必须是 20..10000 的整数');
  if (!['student-t', 'none'].includes(numerics.finiteSample)) {
    fail('numerics.finiteSample 必须为 student-t 或 none');
  }

  return input;
}

export function spendingCumulative(plan) {
  const { alpha } = plan;
  const fractions = plan.looks.fractions;
  const spending = plan.spending;
  const critical = normalQuantile(1 - alpha / 2);
  if (spending.type === 'obrien-fleming') {
    return fractions.map(fraction => 2 - 2 * normalCdf(critical / Math.sqrt(fraction)));
  }
  if (spending.type === 'pocock') {
    return fractions.map(fraction => alpha * Math.log(1 + (Math.E - 1) * fraction));
  }
  return fractions.map(fraction => alpha * fraction ** spending.gamma);
}

// Information is planned by the cumulative number of eligible users; the
// fraction applies to the preregistered maximum and may not be re-chosen
// after data arrive.
export function targetUserCount(maxUsers, fraction) {
  return Math.round(fraction * maxUsers);
}

function quadratureOn(lo, hi, order) {
  const { nodes, weights } = gaussLegendre(order);
  const nodesOut = new Float64Array(order);
  const weightsOut = new Float64Array(order);
  const middle = (lo + hi) / 2;
  const half = (hi - lo) / 2;
  for (let index = 0; index < order; index += 1) {
    nodesOut[index] = middle + half * nodes[index];
    weightsOut[index] = half * weights[index];
  }
  return { nodes: nodesOut, weights: weightsOut };
}

function stageHalfWidth(variance) {
  return 12 * Math.sqrt(variance) + 2;
}

function normalStage(threshold, variance, order) {
  const halfWidth = stageHalfWidth(variance);
  const { nodes, weights } = quadratureOn(threshold - halfWidth, threshold, order);
  const values = new Float64Array(order);
  let mass = 0;
  for (let index = 0; index < order; index += 1) {
    values[index] = Math.exp(-0.5 * nodes[index] ** 2 / variance) / Math.sqrt(2 * Math.PI * variance);
    mass += weights[index] * values[index];
  }
  return { threshold, variance, nodes, weights, values, mass };
}

function mixtureTail(stage, step, threshold) {
  let total = 0;
  const scale = Math.sqrt(step);
  for (let index = 0; index < stage.nodes.length; index += 1) {
    if (stage.values[index] === 0) continue;
    const standardized = (threshold - stage.nodes[index]) / scale;
    total += stage.weights[index] * stage.values[index] * 0.5 * erfc(standardized / Math.SQRT2);
  }
  return total;
}

function nextStageDensity(previous, step) {
  const scale = Math.sqrt(step);
  const normalizer = 1 / Math.sqrt(2 * Math.PI * step);
  return x => {
    let density = 0;
    for (let prior = 0; prior < previous.nodes.length; prior += 1) {
      const weight = previous.weights[prior] * previous.values[prior];
      if (weight === 0) continue;
      const difference = (x - previous.nodes[prior]) / scale;
      if (difference * difference > 800) continue;
      density += weight * normalizer * Math.exp(-0.5 * difference * difference);
    }
    return density;
  };
}

function extendedStage(previous, step, threshold, variance, order) {
  const halfWidth = stageHalfWidth(variance);
  const { nodes, weights } = quadratureOn(threshold - halfWidth, threshold, order);
  const values = new Float64Array(order);
  const density = nextStageDensity(previous, step);
  let mass = 0;
  for (let index = 0; index < order; index += 1) {
    values[index] = density(nodes[index]);
    mass += weights[index] * values[index];
  }
  return { threshold, variance, nodes, weights, values, mass };
}

function bisectCrossing(tail, target, start, step, tolerance, maxIterations) {
  let lo = start;
  let hi = start;
  let guard = 0;
  while (tail(lo) < target && guard < 200) {
    lo -= Math.max(step, 0.5);
    guard += 1;
  }
  guard = 0;
  while (tail(hi) > target && guard < 200) {
    hi += Math.max(step, 0.5);
    guard += 1;
  }
  if (!(tail(lo) > target && tail(hi) < target)) {
    throw new Error('无法为序贯边界找到数值括区');
  }
  let iterations = 0;
  while (iterations < maxIterations && hi - lo > tolerance * (1 + Math.abs(lo))) {
    const middle = (lo + hi) / 2;
    if (tail(middle) > target) lo = middle;
    else hi = middle;
    iterations += 1;
  }
  return { threshold: (lo + hi) / 2, residual: Math.abs(tail((lo + hi) / 2) - target), iterations };
}

export function solveBoundaries({ fractions, cumulativeAlpha, quadratureOrder, tolerance, maxIterations }) {
  const looks = fractions.length;
  const thresholds = new Array(looks);
  const boundaries = new Array(looks);
  const masses = new Array(looks);
  const residuals = new Array(looks);
  const iterations = new Array(looks);

  const firstIncrement = cumulativeAlpha[0];
  const firstVariance = fractions[0];
  // Two-sided spending: the first-look crossing probability is the whole
  // alpha increment, split equally between the two tails.
  const firstThreshold = Math.sqrt(firstVariance) * normalQuantile(1 - firstIncrement / 2);
  let stage = normalStage(firstThreshold, firstVariance, quadratureOrder);
  thresholds[0] = firstThreshold;
  boundaries[0] = firstThreshold / Math.sqrt(firstVariance);
  masses[0] = stage.mass;
  residuals[0] = Math.abs(stage.mass - (1 - firstIncrement / 2));
  iterations[0] = 0;

  for (let index = 1; index < looks; index += 1) {
    const increment = cumulativeAlpha[index] - cumulativeAlpha[index - 1];
    const variance = fractions[index];
    const step = variance - fractions[index - 1];
    if (!(increment > 0)) throw new Error('累计 alpha 必须严格递增');
    // The retained density covers only the lower half of the continuation
    // region; the matching upper tail is symmetric, so each look targets half
    // of its two-sided alpha increment.
    const solved = bisectCrossing(
      candidate => mixtureTail(stage, step, candidate),
      increment / 2,
      stage.threshold,
      Math.sqrt(step),
      tolerance,
      maxIterations
    );
    thresholds[index] = solved.threshold;
    boundaries[index] = solved.threshold / Math.sqrt(variance);
    residuals[index] = solved.residual;
    iterations[index] = solved.iterations;
    stage = extendedStage(stage, step, solved.threshold, variance, quadratureOrder);
    masses[index] = stage.mass;
  }

  return { boundaries, thresholds, masses, residuals, iterations };
}

// The design solves boundaries under a known-variance normal model. With a
// variance estimated from two small arms the statistic is closer to a
// Student t, so each critical value is scaled by the ratio of the matching t
// quantile to the normal quantile. The scaling uses only the preregistered
// look sizes, never the observed data.
export function finiteSampleCorrection(plan, boundaries, cumulativeAlpha) {
  const fractions = plan.looks.fractions;
  const maxUsers = plan.information.maxUsers;
  const method = plan.numerics.finiteSample;
  if (method === 'none') {
    return {
      method: 'none',
      boundaries: [...boundaries],
      factor: boundaries.map(() => 1),
      degreesOfFreedom: fractions.map(() => Infinity)
    };
  }
  const controlShare = plan.arms.allocation[0];
  if (Math.abs(controlShare - 0.5) > 1e-12) {
    throw new Error('student-t 校正目前只支持 1:1 分配');
  }
  // The statistic uses a variance estimated separately in each arm, so the
  // relevant t degrees of freedom are those of one arm's sample, not the
  // pooled count. Using the more conservative per-arm value keeps the
  // correction honest at small look sizes.
  const degreesOfFreedom = fractions.map(fraction => {
    const users = Math.round(fraction * maxUsers);
    const perArm = Math.floor(users * plan.arms.allocation[0]);
    if (perArm < 3) throw new Error('student-t 校正要求每个观察点每组至少 3 名用户');
    return perArm - 1;
  });
  const factor = cumulativeAlpha.map((spent, index) =>
    studentTQuantile(1 - spent / 2, degreesOfFreedom[index]) /
    normalQuantile(1 - spent / 2));
  return {
    method: 'student-t',
    boundaries: boundaries.map((value, index) => value * factor[index]),
    factor,
    degreesOfFreedom
  };
}

function correlations(fractions) {
  return fractions.map((left, leftIndex) => fractions.map((right, rightIndex) =>
    leftIndex === rightIndex ? 1 : Math.sqrt(left / right)));
}

export function compileDesign(plan) {
  validatePlan(plan);
  const fractions = plan.looks.fractions;
  const cumulativeAlpha = spendingCumulative(plan);
  const declaredFinal = cumulativeAlpha[cumulativeAlpha.length - 1];
  if (Math.abs(declaredFinal - plan.alpha) > 1e-10) {
    throw new Error('alpha-spending 设计在最终观察点未用完 alpha');
  }
  for (let index = 1; index < cumulativeAlpha.length; index += 1) {
    if (!(cumulativeAlpha[index] > cumulativeAlpha[index - 1])) {
      throw new Error('alpha-spending 累计值必须严格递增');
    }
  }
  if (!(cumulativeAlpha[0] > 0)) throw new Error('首个观察点必须消耗正的 alpha');

  const numerics = plan.numerics;
  const base = solveBoundaries({ fractions, cumulativeAlpha, ...numerics, quadratureOrder: numerics.quadratureOrder });
  const refined = solveBoundaries({
    fractions,
    cumulativeAlpha,
    quadratureOrder: numerics.quadratureOrder + numerics.comparisonOrder,
    tolerance: numerics.tolerance / 10,
    maxIterations: numerics.maxIterations
  });

  const boundaryShift = Math.max(...base.boundaries.map((value, index) =>
    Math.abs(value - refined.boundaries[index])));
  let massError = 0;
  for (let index = 0; index < fractions.length; index += 1) {
    massError = Math.max(massError,
      Math.abs(base.masses[index] - (1 - cumulativeAlpha[index] / 2)));
  }
  const residual = Math.max(...base.residuals);
  if (!(massError < 1e-8) || !(boundaryShift < 1e-8)) {
    throw new Error('序贯边界数值近似未达到精度要求');
  }

  const corrected = finiteSampleCorrection(plan, base.boundaries, cumulativeAlpha);

  return {
    id: plan.id,
    maxUsers: plan.information.maxUsers,
    randomizationUnit: plan.arms.randomizationUnit,
    amountCap: plan.outcome.amountCap,
    alpha: plan.alpha,
    sides: plan.sides,
    spending: { ...plan.spending },
    fractions: [...fractions],
    cumulativeAlpha,
    increments: cumulativeAlpha.map((value, index) =>
      value - (index === 0 ? 0 : cumulativeAlpha[index - 1])),
    boundaries: corrected.boundaries,
    canonicalThresholds: base.thresholds,
    normalModelCrossing: base.masses.map(mass => 2 * (1 - mass)),
    correlations: correlations(fractions),
    assumptions: [
      '检验统计量在各观察点服从多元正态，协方差由信息比例决定 cov(Z_i,Z_j)=sqrt(f_i/f_j)',
      '信息比例按预先登记的合格用户数计算，且每用户恰好属于一组',
      '结局为每用户截尾金额，组内独立同分布，方差由当前数据估计',
      '边界先在已知方差的正态模型下按 alpha-spending 求解，再按登记观察点的 t 分位数做有限样本校正',
      '双侧 alpha 按登记的 alpha-spending 函数在计划观察点消耗，观察点之外不作决策'
    ],
    numerical: {
      quadratureOrder: numerics.quadratureOrder,
      refinedQuadratureOrder: numerics.quadratureOrder + numerics.comparisonOrder,
      boundaryShift,
      massError,
      spendingResidual: residual,
      bisectionIterations: Math.max(...base.iterations),
      tolerance: numerics.tolerance,
      totalAlpha: cumulativeAlpha[cumulativeAlpha.length - 1],
      targetAlpha: plan.alpha,
      finiteSample: {
        method: corrected.method,
        correctionFactors: corrected.factor,
        degreesOfFreedom: corrected.degreesOfFreedom,
        calibratedBoundaries: corrected.boundaries
      },
      method: '高斯-勒让德积分递推保留区域密度，对边界二分；用更高阶数与更小容差复核'
    }
  };
}

function sampleVariance(values, mean) {
  if (values.length < 2) return NaN;
  let total = 0;
  for (const value of values) total += (value - mean) ** 2;
  return total / (values.length - 1);
}

export function evaluateCohort(users, plan) {
  const control = [];
  const treatment = [];
  let cappedAmountTotal = 0;
  for (const user of users) {
    cappedAmountTotal += user.amount;
    if (user.arm === plan.arms.control) control.push(user.amount);
    else if (user.arm === plan.arms.treatment) treatment.push(user.amount);
  }
  if (control.length < 2 || treatment.length < 2) {
    throw new Error('每组至少需要两名用户才能估计方差');
  }
  const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  const meanControl = mean(control);
  const meanTreatment = mean(treatment);
  const varianceControl = sampleVariance(control, meanControl);
  const varianceTreatment = sampleVariance(treatment, meanTreatment);
  const standardError = Math.sqrt(varianceControl / control.length + varianceTreatment / treatment.length);
  const difference = meanTreatment - meanControl;
  const statistic = standardError > 0 ? difference / standardError : 0;
  return {
    users: control.length + treatment.length,
    control: { users: control.length, mean: meanControl, variance: varianceControl },
    treatment: { users: treatment.length, mean: meanTreatment, variance: varianceTreatment },
    difference,
    standardError,
    statistic,
    nominalTwoSidedP: 2 * (1 - normalCdf(Math.abs(statistic))),
    cappedAmountTotal
  };
}

export function aggregateUsers(records, plan) {
  const controlArm = plan.arms.control;
  const treatmentArm = plan.arms.treatment;
  const expectedArms = new Set([controlArm, treatmentArm]);
  const cap = plan.outcome.amountCap;
  const perUserCapFirst = plan.outcome.perUserAggregation === 'cap-each-then-sum';
  const grouped = new Map();

  for (const row of records) {
    if (typeof row.user !== 'string' || row.user.length === 0) {
      throw new Error('记录缺少用户键');
    }
    let entry = grouped.get(row.user);
    if (!entry) {
      entry = {
        user: row.user, arms: new Set(), assignments: new Set(), amount: 0,
        visible: row.visible, negative: false, records: 0
      };
      grouped.set(row.user, entry);
    }
    entry.records += 1;
    entry.arms.add(row.arm);
    entry.assignments.add(row.assignment);
    entry.visible = Math.max(entry.visible, row.visible);
    if (!(row.amount >= 0) || !Number.isFinite(row.amount)) entry.negative = true;
    entry.amount += perUserCapFirst ? Math.min(cap, row.amount) : row.amount;
  }

  const eligible = [];
  const quarantined = [];
  for (const entry of grouped.values()) {
    const reasons = [];
    if (entry.arms.size > 1) reasons.push('multiple-arms');
    if (entry.assignments.size > 1) reasons.push('multiple-assignment-versions');
    if ([...entry.arms].some(arm => !expectedArms.has(arm))) reasons.push('unexpected-arm');
    if (entry.negative) reasons.push('invalid-amount');
    if (reasons.length > 0) {
      quarantined.push({ user: entry.user, reasons, records: entry.records });
      continue;
    }
    const [arm] = [...entry.arms];
    eligible.push({
      user: entry.user,
      arm,
      amount: Math.min(cap, entry.amount),
      visible: entry.visible
    });
  }

  eligible.sort((left, right) => left.visible - right.visible || left.user.localeCompare(right.user, 'en'));
  quarantined.sort((left, right) => left.user.localeCompare(right.user, 'en'));
  return {
    eligible,
    quarantined,
    usersObserved: grouped.size,
    recordsAccepted: records.length - quarantined.reduce((sum, entry) => sum + entry.records, 0),
    quarantineCounts: quarantined.reduce((counts, entry) => {
      for (const reason of entry.reasons) counts[reason] = (counts[reason] ?? 0) + 1;
      return counts;
    }, {})
  };
}
