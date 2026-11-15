import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { compileDesign } from '../src/sequential.js';

const plan = JSON.parse(await readFile('data/plan.json', 'utf8'));

function run(args) {
  return spawnSync(process.execPath, ['src/cli.js', ...args], { encoding: 'utf8' });
}

test('design 命令输出边界、累计 alpha 与数值误差', () => {
  const result = run(['design']);
  assert.equal(result.status, 0, result.stderr);
  const document = JSON.parse(result.stdout);
  const design = compileDesign(plan);
  assert.deepEqual(document.boundaryCritical, design.boundaries);
  assert.deepEqual(document.cumulativeAlpha, design.cumulativeAlpha);
  assert.ok(document.numerical.boundaryShift < 1e-9);
  assert.ok(document.assumptions.length >= 3);
  assert.equal(document.planId, plan.id);
});

test('simulate 命令接受规模与种子并输出误差区间', () => {
  const first = run(['simulate', '--runs', '60', '--seed', '42', '--users', '120']);
  assert.equal(first.status, 0, first.stderr);
  const document = JSON.parse(first.stdout);
  assert.equal(document.runs, 60);
  assert.equal(document.config.seed, 42);
  assert.equal(document.config.users, 120);
  assert.ok(document.rejectionInterval.low <= document.rejectionRate);
  assert.ok(document.rejectionInterval.high >= document.rejectionRate);
  assert.ok(document.design.numerical.massError < 1e-9);
  const second = run(['simulate', '--runs', '60', '--seed', '42', '--users', '120']);
  assert.deepEqual(JSON.parse(second.stdout), document);
});

test('look 命令要求台账路径且不推进未达信息量的观察点', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'cli-look-'));
  try {
    const store = join(folder, 'ledger.json');
    const missing = run(['look']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /--store/);
    const result = run(['look', '--store', store, '--input', 'data/records.json']);
    // The drill data reaches every planned look, so this consumes one.
    assert.equal(result.status, 0, result.stderr);
    const document = JSON.parse(result.stdout);
    assert.equal(document.looks.length, 1);
    assert.equal(document.status, 'ongoing');
    const replay = run(['look', '--store', store, '--input', 'data/records.json']);
    const replayed = JSON.parse(replay.stdout);
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.looks.length, 1);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('计划指纹被篡改时 look 拒绝使用既有台账', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'cli-plan-'));
  try {
    const store = join(folder, 'ledger.json');
    const altered = join(folder, 'plan.json');
    const changed = JSON.parse(JSON.stringify(plan));
    changed.alpha = 0.04;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(altered, JSON.stringify(changed));
    const first = run(['look', '--store', store, '--input', 'data/records.json']);
    assert.equal(first.status, 0, first.stderr);
    const second = run(['look', '--store', store, '--input', 'data/records.json', '--plan', altered]);
    assert.equal(second.status, 1);
    assert.match(second.stderr, /计划指纹/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
