import { analyzeSequence, createLedger } from './trial.js';
import { aggregateUsers, targetUserCount } from './sequential.js';
import { mulberry32, wilsonInterval } from './normal.js';

// Simulation harness for operating characteristics and demo scenarios. It
// drives the same analysis code as the CLI; only the record source differs.
// Simulated data are generated once per trial and then revealed cumulatively
// at the preregistered information fractions, so a trial without a rejection
// really reaches its final look.

export const DEFAULT_SIMULATION = {
  runs: 2000,
  users: 192,
  controlMean: 50,
  treatmentMean: 50,
  standardDeviation: 30,
  cap: 1000,
  corruptionRate: 0,
  seed: 83
};

function positiveInteger(value, label, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} 必须是至少为 ${minimum} 的整数`);
  }
  return value;
}

function finite(value, label, minimum = -Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new Error(`${label} 必须是大于等于 ${minimum} 的有限数值`);
  }
  return value;
}

export function normalizeSimulation(overrides = {}, plan) {
  const config = { ...DEFAULT_SIMULATION, users: plan ? plan.information.maxUsers : DEFAULT_SIMULATION.users };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in DEFAULT_SIMULATION)) throw new Error(`未知的模拟参数 ${key}`);
    config[key] = value;
  }
  positiveInteger(config.runs, 'runs', 1);
  if (plan && (!Number.isSafeInteger(config.users) || config.users < plan.information.maxUsers)) {
    throw new Error('模拟用户数不能少于登记计划的最大信息量，否则无法到达最终观察点');
  }
  positiveInteger(config.users, 'users', 8);
  finite(config.controlMean, 'controlMean', 0);
  finite(config.treatmentMean, 'treatmentMean', 0);
  finite(config.standardDeviation, 'standardDeviation', 0);
  if (!(config.standardDeviation > 0)) throw new Error('standardDeviation 必须大于 0');
  finite(config.cap, 'cap', 1);
  finite(config.corruptionRate, 'corruptionRate', 0);
  if (config.corruptionRate > 1) throw new Error('corruptionRate 必须位于 0..1');
  positiveInteger(config.seed, 'seed', 0);
  if (plan && config.cap !== plan.outcome.amountCap) {
    throw new Error('模拟的截尾上限必须与登记计划一致');
  }
  return config;
}

export function drawAmount(random, mean, standardDeviation, cap) {
  const u1 = Math.max(random(), Number.MIN_VALUE);
  const u2 = random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.min(cap, Math.max(0, mean + standardDeviation * z));
}

export function simulateRecords(plan, config, random) {
  const records = [];
  const control = plan.arms.control;
  const treatment = plan.arms.treatment;
  const cap = plan.outcome.amountCap;
  const total = Math.max(config.users, plan.information.maxUsers);
  let sequence = 0;
  for (let user = 0; user < total; user += 1) {
    const visible = Math.floor((user + 1) * 12 / total);
    const arms = random() < config.corruptionRate
      ? [control, treatment]
      : [random() < plan.arms.allocation[0] ? control : treatment];
    for (const arm of arms) {
      const mean = arm === control ? config.controlMean : config.treatmentMean;
      records.push({
        id: `s${String(sequence).padStart(6, '0')}`,
        user: `u${String(user).padStart(5, '0')}`,
        arm,
        amount: drawAmount(random, mean, config.standardDeviation, cap),
        visible,
        assignment: 1
      });
      sequence += 1;
    }
  }
  return records;
}

// Reveal the synthetic records at each planned information level and drive
// the production analysis. Returns only the preregistered decision path.
export function replayTrial(plan, design, records) {
  const byUser = new Map();
  for (const record of records) {
    if (!byUser.has(record.user)) byUser.set(record.user, []);
    byUser.get(record.user).push(record);
  }
  const users = [...byUser.keys()].sort((left, right) => left.localeCompare(right, 'en'));
  const ledger = createLedger(plan, design);

  for (let index = 0; index < design.fractions.length; index += 1) {
    if (ledger.status !== 'ongoing') break;
    const target = targetUserCount(design.maxUsers, design.fractions[index]);
    if (users.length < target) break;
    const visible = users.slice(0, target)
      .flatMap(user => byUser.get(user))
      .sort((left, right) => left.id.localeCompare(right.id, 'en'));
    analyzeSequence(design, plan, visible, ledger);
  }

  const nominal = ledger.looks.map(look => look.statistics.nominalTwoSidedP);
  const finalVisible = users
    .slice(0, Math.min(users.length, design.maxUsers))
    .flatMap(user => byUser.get(user));
  return {
    status: ledger.status,
    looks: ledger.looks.length,
    rejected: ledger.status === 'stopped',
    stoppedAtLook: ledger.status === 'stopped' ? ledger.looks.length : null,
    anyNominalSignificant: nominal.some(value => value < plan.alpha),
    finalInformation: ledger.looks.length
      ? ledger.looks[ledger.looks.length - 1].information : 0,
    quarantined: aggregateUsers(finalVisible, plan).quarantined.length
  };
}

export function runSimulations(plan, design, overrides = {}) {
  const config = normalizeSimulation(overrides, plan);
  const random = mulberry32(config.seed);
  const stopAt = new Array(design.fractions.length).fill(0);
  let rejections = 0;
  let naiveRejections = 0;
  let notReachedFinal = 0;
  let quarantinedTotal = 0;
  const informationAtStop = [];
  for (let run = 0; run < config.runs; run += 1) {
    const records = simulateRecords(plan, config, random);
    const outcome = replayTrial(plan, design, records);
    if (outcome.rejected) {
      rejections += 1;
      stopAt[outcome.stoppedAtLook - 1] += 1;
      informationAtStop.push(outcome.finalInformation);
    }
    if (outcome.anyNominalSignificant) naiveRejections += 1;
    if (outcome.looks < design.fractions.length) notReachedFinal += 1;
    quarantinedTotal += outcome.quarantined;
  }
  const interval = wilsonInterval(rejections, config.runs);
  const meanUsers = informationAtStop.length
    ? informationAtStop.reduce((sum, value) => sum + value, 0) / informationAtStop.length
    : null;
  return {
    config,
    runs: config.runs,
    rejections,
    rejectionRate: rejections / config.runs,
    rejectionInterval: interval,
    plannedAlpha: plan.alpha,
    naiveAnyLookRate: naiveRejections / config.runs,
    stopAtLook: Object.fromEntries(stopAt.map((count, index) => [index + 1, count])),
    meanUsersAtStop: meanUsers,
    trialsNotReachingFinalLook: notReachedFinal,
    meanQuarantinedUsers: quarantinedTotal / config.runs,
    nullHypothesis: config.controlMean === config.treatmentMean && config.corruptionRate === 0
  };
}
