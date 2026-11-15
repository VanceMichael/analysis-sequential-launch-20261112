import { open, readFile, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fingerprint } from './dataset.js';
import { writeResult } from './output.js';
import {
  aggregateUsers, compileDesign, evaluateCohort, targetUserCount
} from './sequential.js';

// A trial ledger records preregistration-bound decisions and never edits them
// in place. Late corrections and extra users are appended as supplemental
// analyses with affectsDecision=false; the original decision stays intact.

const LEDGER_VERSION = 1;

function designSnapshot(design) {
  return {
    alpha: design.alpha,
    sides: design.sides,
    spending: design.spending,
    fractions: design.fractions,
    cumulativeAlpha: design.cumulativeAlpha,
    increments: design.increments,
    boundaries: design.boundaries,
    correlations: design.correlations,
    maxUsers: design.maxUsers,
    numerics: design.numerical
  };
}

function designDigest(design) {
  return fingerprint(designSnapshot(design));
}

export function createLedger(plan, design) {
  return {
    version: LEDGER_VERSION,
    planId: plan.id,
    planFingerprint: fingerprint(plan),
    designFingerprint: designDigest(design),
    design: designSnapshot(design),
    status: 'ongoing',
    lastRequest: null,
    looks: [],
    supplementals: []
  };
}

function verifyLedger(ledger, plan, design) {
  if (ledger === null || typeof ledger !== 'object' || Array.isArray(ledger)) {
    throw new Error('试验台账不是对象');
  }
  if (ledger.version !== LEDGER_VERSION) throw new Error('不支持的试验台账版本');
  if (ledger.planId !== plan.id) throw new Error(`台账属于计划 ${ledger.planId}，不是 ${plan.id}`);
  if (ledger.planFingerprint !== fingerprint(plan)) {
    throw new Error('计划与台账登记的计划指纹不一致；已登记的计划不可就地修改');
  }
  if (ledger.designFingerprint !== designDigest(design)) {
    throw new Error('计划生成的双侧边界与台账登记的设计不一致');
  }
}

function lastLook(ledger) {
  return ledger.looks.length === 0 ? null : ledger.looks[ledger.looks.length - 1];
}

function cohortFingerprint(cohort) {
  return fingerprint(cohort.map(user => ({
    user: user.user, arm: user.arm, amount: user.amount, visible: user.visible
  })));
}

// Every prior look froze the first `targetUsers` eligible users at that time.
// If those rows changed, the original decision is not silently recomputed.
function verifyFrozenCohorts(ledger, eligible) {
  for (const look of ledger.looks) {
    const current = eligible.slice(0, look.targetUsers);
    if (current.length < look.targetUsers) {
      throw new Error('先前观察点冻结的用户已不在当前队列；数据更正需通过 supplement 记录补充分析');
    }
    if (cohortFingerprint(current) !== look.cohort.fingerprint) {
      throw new Error('先前观察点冻结的用户或金额已被修改；更正需通过 supplement 作为补充分析记录');
    }
  }
}

function pendingLook(design, eligibleCount, index) {
  if (index >= design.fractions.length) {
    return { nextLook: null, reason: 'all-planned-looks-consumed', visibleUsers: eligibleCount };
  }
  const target = targetUserCount(design.maxUsers, design.fractions[index]);
  return {
    nextLook: index + 1,
    fraction: design.fractions[index],
    targetUsers: target,
    visibleUsers: eligibleCount,
    due: eligibleCount >= target,
    reason: eligibleCount >= target ? 'due-in-next-request' : 'information-below-target'
  };
}

export function analyzeSequence(design, plan, records, ledger) {
  verifyLedger(ledger, plan, design);
  const aggregate = aggregateUsers(records, plan);
  const eligible = aggregate.eligible;
  const requestFingerprint = fingerprint([...records]
    .sort((left, right) => left.id.localeCompare(right.id, 'en')));
  // Repeated identical exports are no-ops, even after a decision. This is
  // what makes a look idempotent: no second alpha chance is consumed.
  const replay = ledger.lastRequest !== null && ledger.lastRequest.fingerprint === requestFingerprint;

  // Batch exports can carry users who arrived after the previous look; those
  // users stay outside the frozen decision. The frozen cohort itself must be
  // byte-for-byte unchanged, so a correction cannot be passed off as growth.
  const previousInformation = lastLook(ledger)?.information ?? 0;
  if (previousInformation > 0 && eligible.length < previousInformation) {
    throw new Error('当前合格用户少于已记录观察点；冻结队列已改变，更正需通过 supplement 作为补充分析记录');
  }
  // Quarantined users are already counted in previousInformation, so the
  // comparison above is on the eligible queue alone.
  verifyFrozenCohorts(ledger, eligible);

  if (ledger.status !== 'ongoing') {
    if (!replay) {
      if (eligible.length > previousInformation) {
        throw new Error('实验已按计划结束，不能追加用户在同一计划下重开；请使用 supplement 记录补充分析');
      }
      throw new Error('实验已按计划结束，不能更正数据并重开同一计划；请使用 supplement 记录补充分析');
    }
    return {
      ledger,
      aggregate,
      // Keep the post-decision data visible but outside the decision: these
      // users arrived after the recorded cohort.
      pending: null,
      postStopUsers: Math.max(0, eligible.length - previousInformation),
      newLook: false,
      replayed: true
    };
  }

  if (replay) {
    return {
      ledger,
      aggregate,
      pending: pendingLook(design, eligible.length, ledger.looks.length),
      postStopUsers: 0,
      newLook: false,
      replayed: true
    };
  }

  // One request consumes at most one planned look. Several exports arriving
  // at once are not collapsed into several decisions; the caller has to come
  // back for the next look once that information level is reached.
  let newLook = false;
  if (ledger.looks.length < design.fractions.length) {
    const index = ledger.looks.length;
    const target = targetUserCount(design.maxUsers, design.fractions[index]);
    if (eligible.length >= target) {
      const cohort = eligible.slice(0, target);
      const evaluated = evaluateCohort(cohort, plan);
      const boundary = design.boundaries[index];
      const crossed = Math.abs(evaluated.statistic) > boundary;
      const decision = crossed ? 'stop'
        : index === design.fractions.length - 1 ? 'final-no-reject' : 'continue';

      ledger.looks.push({
        look: index + 1,
        fraction: design.fractions[index],
        targetUsers: target,
        visibleUsers: eligible.length,
        information: evaluated.users,
        cohort: {
          fingerprint: cohortFingerprint(cohort),
          users: cohort.map(user => user.user)
        },
        statistics: {
          control: evaluated.control,
          treatment: evaluated.treatment,
          difference: evaluated.difference,
          standardError: evaluated.standardError,
          statistic: evaluated.statistic,
          nominalTwoSidedP: evaluated.nominalTwoSidedP
        },
        boundary: {
          critical: boundary,
          cumulativeAlphaSpent: design.cumulativeAlpha[index],
          alphaIncrement: design.increments[index],
          crossingRule: '|statistic| > critical'
        },
        cumulativeCappedAmount: evaluated.cappedAmountTotal,
        visibleCappedAmountTotal: eligible.reduce((sum, user) => sum + user.amount, 0),
        decision,
        decisionReason: crossed ? 'boundary-crossed' : 'within-boundary'
      });
      newLook = true;
      if (crossed) ledger.status = 'stopped';
      else if (decision === 'final-no-reject') ledger.status = 'completed';
    }
  }

  ledger.lastRequest = {
    fingerprint: requestFingerprint,
    eligibleUsers: eligible.length,
    looksConsumed: ledger.looks.length
  };

  return {
    ledger,
    aggregate,
    pending: ledger.status === 'ongoing'
      ? pendingLook(design, eligible.length, ledger.looks.length) : null,
    postStopUsers: 0,
    newLook,
    replayed: false
  };
}

export function summarizeAggregate(aggregate) {
  return {
    acceptedRecords: aggregate.recordsAccepted,
    eligibleUsers: aggregate.eligible.length,
    usersObserved: aggregate.usersObserved,
    quarantined: aggregate.quarantined.length,
    quarantineCounts: aggregate.quarantineCounts,
    quarantinedUsers: aggregate.quarantined
  };
}

export function documentFor(ledger, design, analyzeResult) {
  return {
    planId: ledger.planId,
    planFingerprint: ledger.planFingerprint,
    status: ledger.status,
    limit: {
      maxUsers: design.maxUsers,
      randomizationUnit: design.randomizationUnit,
      amountCap: design.amountCap
    },
    design: {
      alpha: design.alpha,
      sides: design.sides,
      spending: design.spending,
      fractions: design.fractions,
      cumulativeAlpha: design.cumulativeAlpha,
      increments: design.increments,
      boundaryCritical: design.boundaries,
      correlations: design.correlations,
      numerical: design.numerical,
      assumptions: design.assumptions
    },
    aggregate: summarizeAggregate(analyzeResult.aggregate),
    looks: ledger.looks,
    pending: analyzeResult.pending,
    postStopUsers: analyzeResult.postStopUsers,
    supplementals: ledger.supplementals,
    newLook: analyzeResult.newLook,
    replayed: analyzeResult.replayed,
    ledgerFingerprint: fingerprint(ledger)
  };
}

export function appendSupplemental(ledger, plan, design, records, reason) {
  verifyLedger(ledger, plan, design);
  if (ledger.status === 'ongoing') {
    throw new Error('实验尚未结束，补充分析只用于已停止或已完成的计划');
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new Error('补充分析必须记录原因');
  }
  const aggregate = aggregateUsers(records, plan);
  const digest = fingerprint([...records].sort((left, right) => left.id.localeCompare(right.id, 'en')));
  const existing = ledger.supplementals.find(entry => entry.fingerprint === digest);
  if (existing) return { ledger, aggregate, entry: existing, created: false };

  const evaluated = evaluateCohort(aggregate.eligible, plan);
  const entry = {
    id: ledger.supplementals.length + 1,
    reason,
    fingerprint: digest,
    information: evaluated.users,
    usersObserved: aggregate.usersObserved,
    quarantined: aggregate.quarantined.length,
    quarantineCounts: aggregate.quarantineCounts,
    statistics: {
      control: evaluated.control,
      treatment: evaluated.treatment,
      difference: evaluated.difference,
      standardError: evaluated.standardError,
      statistic: evaluated.statistic,
      nominalTwoSidedP: evaluated.nominalTwoSidedP
    },
    cumulativeCappedAmount: evaluated.cappedAmountTotal,
    decisionRule: 'descriptive-only',
    affectsDecision: false,
    note: '后到数据或更正只进入补充分析，原始决策保持不变'
  };
  ledger.supplementals.push(entry);
  return { ledger, aggregate, entry, created: true };
}

// --- ledger persistence -------------------------------------------------

async function readLedger(path, plan, design) {
  try {
    const document = JSON.parse(await readFile(path, 'utf8'));
    verifyLedger(document, plan, design);
    return document;
  } catch (error) {
    if (error.code === 'ENOENT') return createLedger(plan, design);
    throw error;
  }
}

function sleep(milliseconds) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
}

async function acquireLock(path, { staleMilliseconds = 10000, timeoutMilliseconds = 2000 } = {}) {
  const lock = `${resolve(path)}.lock`;
  const started = Date.now();
  while (true) {
    try {
      const handle = await open(lock, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      return lock;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const details = await stat(lock);
        if (Date.now() - details.mtimeMs > staleMilliseconds) {
          await rm(lock, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() - started > timeoutMilliseconds) throw new Error('试验台账被其他进程占用');
      await sleep(10);
    }
  }
}

async function withLedger(path, plan, design, operation) {
  const lock = await acquireLock(path);
  try {
    const ledger = await readLedger(path, plan, design);
    const result = operation(ledger);
    await writeResult(path, result.ledger);
    return result;
  } finally {
    await rm(lock, { force: true });
  }
}

export async function runLook({ plan, storePath, records }) {
  const design = compileDesign(plan);
  return withLedger(storePath, plan, design, ledger => {
    const result = analyzeSequence(design, plan, records, ledger);
    return { ...result, document: documentFor(result.ledger, design, result) };
  });
}

export async function runSupplemental({ plan, storePath, records, reason }) {
  const design = compileDesign(plan);
  return withLedger(storePath, plan, design, ledger => {
    const result = appendSupplemental(ledger, plan, design, records, reason);
    return {
      ...result,
      document: {
        planId: ledger.planId,
        status: ledger.status,
        supplemental: result.entry,
        created: result.created,
        ledgerFingerprint: fingerprint(ledger)
      }
    };
  });
}
