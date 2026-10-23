// `pe do "<viec>"` — giao 1 viec cho agent lam ngay trong project hien tai:
// model tu doc/sua file, chay lenh theo muc duyet (approval).
import readline from 'node:readline';
import { loadConfig, missingFields, loadProjectContext } from '../lib/config.mjs';
import { createToolRunner } from '../lib/tools.mjs';
import { runAgent, AGENT_SYSTEM } from '../lib/agent.mjs';
import { currentTimeLine } from '../lib/now.mjs';

export function printAgentEvent(type, data) {
  if (type === 'tool') console.log(`  [tool] ${data.desc} ...`);
  else if (type === 'result') console.log(`  [xong] ${data.summary}`);
  else if (type === 'note') console.log(data);
}

/** Hoi xac nhan qua terminal; stdin khong phai TTY thi mac dinh tu choi. */
export function makeConfirm() {
  let rl = null;
  return (desc) => new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      console.log(`  [can duyet] ${desc} — khong phai terminal nen tu choi (dung --yolo hoac chat de duyet tay).`);
      resolve(false);
      return;
    }
    if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`  Cho phep ${desc}? (y/N) `, (a) => resolve(/^y(es)?$/i.test(a.trim())));
  });
}

export async function runDo(args = []) {
  let yolo = false;
  let approval;
  let web = false;
  const taskParts = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--yolo') { yolo = true; continue; }
    if (a === '--web') { web = true; continue; }
    if (a === '--approval') { approval = Number(args[++i]); continue; }
    taskParts.push(a);
  }
  const task = taskParts.join(' ').trim();
  if (!task) {
    console.error('Dung: pe do "<viec can lam>" [--yolo] [--approval 1|2|3] [--web]');
    process.exitCode = 2;
    return;
  }
  const cfg = await loadConfig();
  const miss = missingFields(cfg);
  if (miss.length) {
    console.error(`Chua cau hinh du: thieu ${miss.join(', ')}. Chay \`pe init\` truoc.`);
    process.exitCode = 2;
    return;
  }
  const level = yolo ? 3 : ([1, 2, 3].includes(approval) ? approval : cfg.approval);
  const ctx = await loadProjectContext();
  const runner = createToolRunner({ root: process.cwd(), approval: level, confirm: makeConfirm() });
  const messages = [
    { role: 'system', content: AGENT_SYSTEM + `\n\n${currentTimeLine()}` + (ctx ? `\n\nNgu canh project:\n${ctx.text}` : '') },
    { role: 'user', content: task },
  ];
  console.log(`pe do (muc duyet ${level}${level === 3 ? ' — yolo' : ''}${web ? ', web: bat' : ''}): ${task}\n`);
  try {
    const { text } = await runAgent({ cfg, model: cfg.model, messages, runner, onEvent: printAgentEvent, web });
    console.log(`\npe: ${text}`);
  } catch (e) {
    console.error(`Loi: ${e.message}`);
    process.exitCode = 1;
  }
}
