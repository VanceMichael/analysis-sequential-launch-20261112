import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { compileDesign } from '../src/sequential.js';
import { runSimulations } from '../src/simulate.js';
import {
  analyzeSequence, appendSupplemental, createLedger, runLook, runSupplemental
} from '../src/trial.js';

// Short, deterministic demo. The simulation sample size is deliberately small
// so the command finishes quickly; the recorded numbers show what the
// preregistered design does, not a precise error estimate.

const plan = JSON.parse(await readFile('data/plan.json', 'utf8'));
const design = compileDesign(plan);
const records = JSON.parse(await readFile('data/records.json', 'utf8')).records;
const maxUsers = plan.information.maxUsers;
const target = fraction => Math.round(fraction * maxUsers);
const byDay = cutoff => records.filter(record => record.visible <= cutoff);
const view = result => ({
  status: result.ledger.status,
  looks: result.ledger.looks.map(look => ({
    look: look.look,
    information: look.information,
    targetUsers: look.targetUsers,
    statistic: look.statistics.statistic,
    critical: look.boundary.critical,
    cumulativeAlphaSpent: look.boundary.cumulativeAlphaSpent,
    cumulativeCappedAmount: look.cumulativeCappedAmount,
    decision: look.decision
  })),
  pending: result.pending
});

console.log('== 预先登记的设计 ==');
console.log(JSON.stringify({
  planId: plan.id,
  spending: plan.spending,
  fractions: plan.fractions ?? plan.looks.fractions,
  cumulativeAlpha: design.cumulativeAlpha,
  boundaryCritical: design.boundaries,
  numerical: design.numerical,
  assumptions: design.assumptions
}, null, 2));

console.log('\n== 例 1：信息量不足的请求不消费观察点 ==');
{
  const ledger = createLedger(plan, design);
  console.log(JSON.stringify(view(analyzeSequence(design, plan, byDay(3), ledger)), null, 2));
}

console.log('\n== 例 2：按计划观察点推进，重复请求幂等 ==');
{
  const ledger = createLedger(plan, design);
  for (const day of [6, 9, 12]) {
    const result = analyzeSequence(design, plan, byDay(day), ledger);
    console.log(`day ${day}:`, JSON.stringify(view(result)));
  }
  const replay = analyzeSequence(design, plan, byDay(12), ledger);
  console.log('重复 day 12 请求:', JSON.stringify({ replayed: replay.replayed, looks: replay.ledger.looks.length }));
}

console.log('\n== 例 3：分组污染被隔离 ==');
{
  const polluted = [...byDay(9), { ...byDay(9)[0], id: 'conflict', arm: plan.arms.treatment }];
  const ledger = createLedger(plan, design);
  const result = analyzeSequence(design, plan, polluted, ledger);
  console.log(JSON.stringify({
    quarantined: result.aggregate.quarantined,
    quarantineCounts: result.aggregate.quarantineCounts,
    eligibleUsers: result.aggregate.eligible.length,
    looks: result.ledger.looks.length,
    pending: result.pending
  }, null, 2));
}

console.log('\n== 例 4：提前停止 ==');
{
  const shifted = byDay(6).map(record => record.arm === plan.arms.treatment
    ? { ...record, amount: record.amount + 10 } : record);
  const ledger = createLedger(plan, design);
  console.log(JSON.stringify(view(analyzeSequence(design, plan, shifted, ledger)), null, 2));
}

console.log('\n== 例 5：已停止计划的后到更正只进入补充分析 ==');
{
  const folder = await mkdtemp(join(tmpdir(), 'sequential-demo-'));
  try {
    const store = join(folder, 'ledger.json');
    const shifted = byDay(6).map(record => record.arm === plan.arms.treatment
      ? { ...record, amount: record.amount + 10 } : record);
    const look = await runLook({ plan, storePath: store, records: shifted });
    console.log('停止时决定:', JSON.stringify(look.ledger.looks[0].decision));
    const late = [...byDay(12), { id: 'late-1', user: 'late-1', arm: 'A', amount: 40, visible: 12, assignment: 1 }];
    const refused = await runLook({ plan, storePath: store, records: late }).then(
      () => null,
      error => error.message
    );
    console.log('追加用户重开被拒绝:', refused);
    const supplemental = await runSupplemental({ plan, storePath: store, records: late, reason: '后到结算更正' });
    console.log(JSON.stringify({
      created: supplemental.document.created,
      affectsDecision: supplemental.entry.affectsDecision,
      originalDecision: JSON.parse(JSON.stringify(look.ledger.looks[0].decision)),
      decisionCount: supplemental.ledger.looks.length
    }, null, 2));
    const again = await runSupplemental({ plan, storePath: store, records: late, reason: '重复请求' });
    console.log('重复补充请求:', JSON.stringify({ created: again.document.created, supplementals: again.ledger.supplementals.length }));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

console.log('\n== 例 6：小规模零效应模拟 ==');
{
  const started = performance.now();
  const result = runSimulations(plan, design, { runs: 300, seed: plan.seed ?? 83 });
  console.log(JSON.stringify({
    runs: result.runs,
    rejections: result.rejections,
    rejectionRate: result.rejectionRate,
    wilson95: result.rejectionInterval,
    plannedAlpha: result.plannedAlpha,
    naiveAnyLookRate: result.naiveAnyLookRate,
    stopAtLook: result.stopAtLook,
    trialsNotReachingFinalLook: result.trialsNotReachingFinalLook,
    meanUsersAtStop: result.meanUsersAtStop,
    note: '演示规模小，区间很宽；正式评估应增加 runs'
  }, null, 2));
  console.log(`simulate 用时约 ${Math.round(performance.now() - started)} 毫秒`);
}
