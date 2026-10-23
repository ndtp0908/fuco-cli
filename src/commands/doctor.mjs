// `pe doctor` — kiem tra moi truoc khi dung: node, config, ket noi worker, auth, model.
import { loadConfig, missingFields, loadProjectContext } from '../lib/config.mjs';
import { apiFetch, PeError } from '../lib/api.mjs';
import { listPending } from '../lib/queue.mjs';

const OK = '\u2713';
const NO = '\u2717';

export async function runDoctor() {
  const cfg = await loadConfig();
  let fail = 0;
  const line = (ok, msg) => {
    console.log(`  ${ok ? OK : NO} ${msg}`);
    if (!ok) fail++;
  };

  console.log('pe doctor\n');

  // 1. Node
  const major = Number(process.versions.node.split('.')[0]);
  line(major >= 18, `Node.js ${process.versions.node} (>= 18)`);

  // 2. Config file
  line(cfg._meta.fileExists, `file cau hinh ${cfg._meta.path}${cfg._meta.fileExists ? '' : ' (chua co — chay `pe init`)'}`);

  // 3. Cac truong bat buoc
  const miss = missingFields(cfg);
  line(miss.length === 0, miss.length === 0
    ? `workerUrl + proxySecret da co${cfg._meta.fromEnv.workerUrl || cfg._meta.fromEnv.proxySecret ? ' (mot phan tu bien moi truong)' : ''}`
    : `thieu: ${miss.join(', ')} — chay \`pe init\` hoac dat bien moi truong`);

  // 3b. Project hien tai (.pe/)
  if (cfg._meta.projectDir) {
    const ctx = await loadProjectContext();
    line(true, `project: ${cfg._meta.projectDir}${cfg._meta.projectModel ? ` (model rieng: ${cfg._meta.projectModel})` : ''}${ctx ? ` + context.md (${ctx.text.length} ky tu)` : ''}`);
  } else {
    console.log('  - chua co .pe/ cho project nay (pe init --project de tao)');
  }

  // 4. Model hop le (worker chi cho :free)
  line(String(cfg.model).endsWith(':free'), `model mac dinh "${cfg.model}"${String(cfg.model).endsWith(':free') ? '' : ' — worker se tu choi (403)'}`);

  // 4b. Pe-worker (hang doi assign) — thong tin them, khong tinh fail
  try {
    const pend = await listPending(cfg);
    console.log(`  ${OK} pe-worker (assign) noi duoc — ${pend.length} viec dang cho`);
  } catch (e) {
    console.log(`  - pe-worker (assign) chua noi duoc: ${e.message}`);
  }

  // 5. Ket noi worker + auth (chi khi du thong tin)
  if (miss.length === 0) {
    try {
      const data = await apiFetch(cfg, '/api/models', { timeoutMs: 20000 });
      const n = Array.isArray(data?.data) ? data.data.length : 0;
      line(true, `worker tra loi OK (${n} model)`);
      const ids = (data.data || []).map((m) => m.id).filter(Boolean);
      line(ids.includes(cfg.model), ids.includes(cfg.model)
        ? `model "${cfg.model}" co trong danh sach worker`
        : `model "${cfg.model}" KHONG thay trong danh sach worker — doi bang \`pe model <id>\``);
    } catch (e) {
      if (e instanceof PeError && e.kind === 'auth') {
        line(false, `sai proxy secret hoac sai worker URL (${e.message})`);
      } else if (e instanceof PeError && e.kind === 'network') {
        line(false, `khong noi duoc toi worker (${e.message})`);
      } else {
        line(false, `worker loi: ${e.message}`);
      }
    }
  } else {
    console.log('  - bo qua kiem tra worker (thieu cau hinh)');
  }

  console.log(fail === 0 ? '\nTat ca deu on — dung `pe ask "xin chao"` de thu.' : `\nCo ${fail} muc can sua.`);
  process.exitCode = fail === 0 ? 0 : 1;
}
