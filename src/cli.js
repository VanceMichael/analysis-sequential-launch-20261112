import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fingerprint, loadDataset } from './dataset.js';
import { summarize } from './domain.js';
import { writeResult } from './output.js';
import { compileDesign } from './sequential.js';
import { runLook, runSupplemental } from './trial.js';
import { runSimulations, normalizeSimulation } from './simulate.js';

const COMMANDS = ['summary', 'inspect', 'design', 'look', 'supplement', 'simulate'];
const OPTION_NAMES = ['--input', '--plan', '--store', '--out', '--reason', '--runs', '--seed', '--users'];

export function parseArguments(args) {
  const [command = 'summary', ...options] = args;
  if (!COMMANDS.includes(command)) throw new Error(`命令应为 ${COMMANDS.join('、')}`);
  const result = { command, input: 'data/records.json', plan: 'data/plan.json' };
  for (let index = 0; index < options.length; index += 2) {
    const name = options[index];
    const value = options[index + 1];
    if (!OPTION_NAMES.includes(name) || !value || value.startsWith('--')) {
      throw new Error(`参数应为 ${OPTION_NAMES.join('、')} 之一后接取值`);
    }
    const key = name.slice(2);
    if (key in result && key !== 'input' && key !== 'plan') throw new Error('参数不可重复');
    result[key] = value;
  }
  return result;
}

function requiredPath(options, name) {
  if (!options[name]) throw new Error(`命令需要 --${name} 路径`);
  return options[name];
}

async function loadPlan(path) {
  const document = JSON.parse(await readFile(path, 'utf8'));
  return document;
}

function parseSimulationOptions(options) {
  const overrides = {};
  for (const key of ['runs', 'seed', 'users']) {
    if (options[key] === undefined) continue;
    if (!/^[0-9]+$/.test(options[key])) throw new Error(`--${key} 必须是非负整数`);
    overrides[key] = Number(options[key]);
  }
  return overrides;
}

export async function main(args) {
  const options = parseArguments(args);
  const plan = options.command === 'design' || options.command === 'look' ||
    options.command === 'supplement' || options.command === 'simulate'
    ? await loadPlan(options.plan) : null;

  if (options.command === 'simulate') {
    const design = compileDesign(plan);
    const result = runSimulations(plan, design, parseSimulationOptions(options));
    const document = {
      ...result,
      planId: plan.id,
      design: {
        alpha: design.alpha,
        fractions: design.fractions,
        cumulativeAlpha: design.cumulativeAlpha,
        boundaryCritical: design.boundaries,
        numerical: design.numerical,
        assumptions: design.assumptions
      },
      inputFingerprint: fingerprint(plan)
    };
    if (options.out) await writeResult(options.out, document);
    return document;
  }

  if (options.command === 'design') {
    const design = compileDesign(plan);
    const document = {
      planId: plan.id,
      alpha: design.alpha,
      sides: design.sides,
      spending: design.spending,
      fractions: design.fractions,
      cumulativeAlpha: design.cumulativeAlpha,
      increments: design.increments,
      boundaryCritical: design.boundaries,
      normalModelCrossing: design.normalModelCrossing,
      correlations: design.correlations,
      numerical: design.numerical,
      assumptions: design.assumptions
    };
    if (options.out) await writeResult(options.out, document);
    return document;
  }

  if (options.command === 'look' || options.command === 'supplement') {
    const store = requiredPath(options, 'store');
    const dataset = await loadDataset(options.input);
    const result = options.command === 'look'
      ? await runLook({ plan, storePath: store, records: dataset.records })
      : await runSupplemental({ plan, storePath: store, records: dataset.records, reason: options.reason });
    const document = { ...result.document, inputFingerprint: dataset.fingerprint };
    if (options.out) await writeResult(options.out, document);
    return document;
  }

  const dataset = await loadDataset(options.input);
  const result = options.command === 'summary' ? summarize(dataset.records)
    : { records: dataset.records.length, fingerprint: dataset.fingerprint,
      fields: dataset.records.length ? Object.keys(dataset.records[0]).sort() : [] };
  const document = { ...result, inputFingerprint: dataset.fingerprint };
  if (options.out) await writeResult(options.out, document);
  return document;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }).catch(error => {
    process.stderr.write(`处理失败：${error.message}\n`);
    process.exitCode = 1;
  });
}
