import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileDesign } from '../src/sequential.js';
import {
  analyzeSequence, appendSupplemental, createLedger, runLook, runSupplemental
} from '../src/trial.js';

const plan = JSON.parse(await readFile('data/plan.json', 'utf8'));
const design = compileDesign(plan);
const raw = JSON.parse(await readFile('data/records.json', 'utf8')).records;
const maxUsers = plan.information.maxUsers;

function visibleUntil(records, cutoff) {
  return records.filter(record => record.visible <= cutoff);
}

const day3 = visibleUntil(raw, 3);
const day6 = visibleUntil(raw, 6);
const day9 = visibleUntil(raw, 9);
const day12 = visibleUntil(raw, 12);

test('未达到观察信息量不消费观察点', () => {
  const ledger = createLedger(plan, design);
  const result = analyzeSequence(design, plan, day3, ledger);
  assert.equal(result.ledger.looks.length, 0);
  assert.equal(result.ledger.status, 'ongoing');
  assert.equal(result.pending.nextLook, 1);
  assert.equal(result.pending.targetUsers, Math.round(0.5 * maxUsers));
  assert.equal(result.pending.visibleUsers, day3.length);
  assert.equal(result.pending.due, false);
  assert.equal(result.pending.reason, 'information-below-target');
  assert.equal(ledger.looks.length, 0);
});

test('按计划观察点依次保存统计量、边界、花费与决定', () => {
  const ledger = createLedger(plan, design);
  const target1 = Math.round(plan.looks.fractions[0] * maxUsers);
  const first = analyzeSequence(design, plan, day6, ledger);
  assert.equal(first.ledger.looks.length, 1);
  assert.deepEqual(Object.keys(first.ledger.looks[0]).sort(), [
    'boundary', 'cohort', 'cumulativeCappedAmount', 'decision', 'decisionReason',
    'fraction', 'information', 'look', 'statistics', 'targetUsers', 'visibleCappedAmountTotal',
    'visibleUsers'
  ]);
  const look = first.ledger.looks[0];
  assert.equal(look.look, 1);
  assert.equal(look.information, target1);
  assert.equal(look.cohort.users.length, target1);
  assert.ok(Math.abs(look.boundary.critical - design.boundaries[0]) < 1e-15);
  assert.ok(Math.abs(look.boundary.cumulativeAlphaSpent - design.cumulativeAlpha[0]) < 1e-15);
  assert.equal(look.decision, 'continue');
  assert.ok(look.cumulativeCappedAmount > 0);
  assert.ok(Number.isFinite(look.statistics.statistic));

  const second = analyzeSequence(design, plan, day9, ledger);
  assert.equal(second.ledger.looks.length, 2);
  assert.equal(second.ledger.looks[1].look, 2);

  const third = analyzeSequence(design, plan, day12, ledger);
  assert.equal(third.ledger.looks.length, 3);
  assert.equal(third.ledger.status, 'completed');
  assert.equal(third.ledger.looks[2].decision, 'final-no-reject');
  assert.equal(third.pending, null);
});

test('重复相同 look 是幂等的，不推进台账也不重复消费 alpha', () => {
  const ledger = createLedger(plan, design);
  const original = analyzeSequence(design, plan, day6, ledger);
  const before = JSON.stringify(original.ledger);
  const replay = analyzeSequence(design, plan, day6, ledger);
  assert.equal(replay.replayed, true);
  assert.equal(replay.newLook, false);
  assert.equal(JSON.stringify(replay.ledger), before);
  assert.equal(replay.ledger.looks.length, 1);
});

test('重复 look 在计划结束后同样不产生第二个决定', () => {
  const ledger = createLedger(plan, design);
  analyzeSequence(design, plan, day6, ledger);
  analyzeSequence(design, plan, day9, ledger);
  analyzeSequence(design, plan, day12, ledger);
  assert.equal(ledger.status, 'completed');
  const before = JSON.stringify(ledger);
  const replay = analyzeSequence(design, plan, day12, ledger);
  assert.equal(replay.replayed, true);
  assert.equal(replay.postStopUsers, 0);
  assert.equal(JSON.stringify(replay.ledger), before);
});

test('已停止计划不能追加用户悄悄重开，更正进入补充分析', async () => {
  const ledger = createLedger(plan, design);
  // Force a stop at the first look by shifting group means upward.
  const shifted = day6.map(record => {
    if (record.arm !== plan.arms.treatment) return record;
    return { ...record, amount: record.amount + 500 };
  });
  analyzeSequence(design, plan, shifted, ledger);
  assert.equal(ledger.status, 'stopped');
  const decided = JSON.stringify(ledger);

  const moreUsers = [...day12, ...[1, 2, 3, 4].map(index => ({
    id: `extra-${index}`, user: `extra-${index}`, arm: 'A', amount: 60, visible: 12, assignment: 1
  }))];
  assert.throws(() => analyzeSequence(design, plan, moreUsers, ledger), /重开|补充分析/);
  assert.equal(JSON.stringify(ledger), decided);
  const supplement = appendSupplemental(ledger, plan, design, moreUsers, '后到用户');
  assert.equal(ledger.status, 'stopped');
  assert.equal(supplement.entry.affectsDecision, false);
});

test('补充分析只追加，不修改既有决定', () => {
  const shifted = day6.map(record => record.arm === 'B'
    ? { ...record, amount: record.amount + 500 } : record);
  const ledger = createLedger(plan, design);
  analyzeSequence(design, plan, shifted, ledger);
  assert.equal(ledger.status, 'stopped');
  const original = JSON.stringify(ledger.looks[0]);

  const moreUsers = [...day12, ...[0, 1, 2, 3].map(index => ({
    id: `late-${index}`, user: `late-${index}`, arm: 'A', amount: 40, visible: 12, assignment: 1
  }))];
  const supplemental = appendSupplemental(ledger, plan, design, moreUsers, '后到结算更正');
  assert.equal(supplemental.created, true);
  assert.equal(JSON.stringify(ledger.looks[0]), original);
  assert.equal(supplemental.entry.affectsDecision, false);
  assert.equal(supplemental.entry.decisionRule, 'descriptive-only');
  assert.equal(ledger.supplementals.length, 1);

  const repeated = appendSupplemental(ledger, plan, design, moreUsers, '再次导出');
  assert.equal(repeated.created, false);
  assert.equal(ledger.supplementals.length, 1);
  assert.equal(JSON.stringify(ledger.looks[0]), original);
});

test('先前冻结用户的更正被拒绝，而不是静默重算', () => {
  const ledger = createLedger(plan, design);
  analyzeSequence(design, plan, day6, ledger);
  const tampered = day9.map(record => record.id === 'r0000'
    ? { ...record, amount: record.amount + 100 } : record);
  assert.throws(() => analyzeSequence(design, plan, tampered, ledger), /更正|冻结/);
  assert.equal(ledger.looks.length, 1);
});

test('分组冲突用户被隔离，不进入统计量', () => {
  const conflicted = [...day6, { ...day6[0], id: 'conflict', arm: plan.arms.treatment }];
  const ledger = createLedger(plan, design);
  const result = analyzeSequence(design, plan, conflicted, ledger);
  assert.equal(result.aggregate.quarantined.length, 1);
  assert.equal(result.aggregate.quarantineCounts['multiple-arms'], 1);
  assert.equal(result.aggregate.recordsAccepted, day6.length - 1);
  // Quarantining one user leaves the first planned cohort one short, so no
  // look is spent and the user is excluded rather than guessed into a group.
  assert.equal(ledger.looks.length, 0);
  assert.equal(result.pending.visibleUsers, day6.length - 1);
  assert.equal(result.pending.reason, 'information-below-target');
});

test('分组冲突隔离后，达到信息量的观察点照常计算', () => {
  const conflicted = [...day9, { ...day9[0], id: 'conflict', arm: plan.arms.treatment }];
  const ledger = createLedger(plan, design);
  const result = analyzeSequence(design, plan, conflicted, ledger);
  assert.equal(result.aggregate.quarantined.length, 1);
  assert.equal(ledger.looks.length, 1);
  const cohortUsers = new Set(ledger.looks[0].cohort.users);
  assert.equal(cohortUsers.has(day9[0].user), false);
  assert.equal(ledger.looks[0].statistics.control.users + ledger.looks[0].statistics.treatment.users,
    ledger.looks[0].information);
});

test('分组冲突导致信息不足时不消费观察点', () => {
  // Quarantine enough users that the planned cohort cannot be formed.
  const conflicted = day6.map(record => ({ ...record }));
  for (let index = 0; index < day6.length; index += 1) {
    const target = Math.round(0.5 * maxUsers);
    if (index < target) {
      // Give every user in the first planned cohort a conflicting row.
      conflicted.push({ ...conflicted[index], id: `q-${index}`, arm: 'A' === day6[index].arm ? 'B' : 'A' });
    }
  }
  const ledger = createLedger(plan, design);
  const result = analyzeSequence(design, plan, conflicted, ledger);
  assert.equal(result.ledger.looks.length, 0);
  assert.equal(result.aggregate.quarantined.length, Math.round(0.5 * maxUsers));
  assert.equal(result.pending.reason, 'information-below-target');
});

test('晚于观察点到达的用户不改变已记录的决定', () => {
  const ledger = createLedger(plan, design);
  analyzeSequence(design, plan, day6, ledger);
  analyzeSequence(design, plan, day9, ledger);
  analyzeSequence(design, plan, day12, ledger);
  const decisions = JSON.stringify(ledger.looks);
  // Replaying an export with more post-stop users would be a different
  // request and must be rejected, not silently re-evaluated.
  const extended = [...day12, { id: 'late', user: 'late', arm: 'A', amount: 0, visible: 12, assignment: 1 }];
  assert.throws(() => analyzeSequence(design, plan, extended, ledger), /重开|补充分析/);
  assert.equal(JSON.stringify(ledger.looks), decisions);
});

test('台账文件跨进程持久化并拒绝被删改的计划', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'trial-'));
  try {
    const store = join(folder, 'ledger.json');
    const alteredPlan = { ...JSON.parse(JSON.stringify(plan)), alpha: 0.04 };
    await runLook({ plan, storePath: store, records: day6 });
    const document = JSON.parse(await readFile(store, 'utf8'));
    assert.equal(document.looks.length, 1);
    assert.equal(document.planId, plan.id);
    await assert.rejects(
      runLook({ plan: alteredPlan, storePath: store, records: day6 }),
      /计划指纹/
    );
    const same = await runLook({ plan, storePath: store, records: day6 });
    assert.equal(same.document.looks.length, 1);
    assert.equal(same.document.replayed, true);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('补充分析经命令行入口也能保持幂等', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'supplement-'));
  try {
    const store = join(folder, 'ledger.json');
    const shifted = day6.map(record => record.arm === 'B'
      ? { ...record, amount: record.amount + 500 } : record);
    await runLook({ plan, storePath: store, records: shifted });
    const late = [...day12, { id: 'x', user: 'x', arm: 'A', amount: 10, visible: 12, assignment: 1 }];
    const first = await runSupplemental({
      plan, storePath: store, records: late, reason: '导出更正'
    });
    assert.equal(first.document.created, true);
    const second = await runSupplemental({
      plan, storePath: store, records: late, reason: '重复请求'
    });
    assert.equal(second.document.created, false);
    const document = JSON.parse(await readFile(store, 'utf8'));
    assert.equal(document.supplementals.length, 1);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
