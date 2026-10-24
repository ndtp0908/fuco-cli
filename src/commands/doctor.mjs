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
  line(cfg._meta.fileExists, `file cấu hình ${cfg._meta.path}${cfg._meta.fileExists ? '' : ' (chưa có — chạy `pe init`)'}`);

  // 3. Cac truong bat buoc
  const miss = missingFields(cfg);
  line(miss.length === 0, miss.length === 0
    ? `workerUrl + proxySecret đã có${cfg._meta.fromEnv.workerUrl || cfg._meta.fromEnv.proxySecret ? ' (một phần từ biến môi trường)' : ''}`
    : `thiếu: ${miss.join(', ')} — chạy \`pe init\` hoặc đặt biến môi trường`);

  // 3b. Project hien tai (.pe/)
  if (cfg._meta.projectDir) {
    const ctx = await loadProjectContext();
    line(true, `project: ${cfg._meta.projectDir}${cfg._meta.projectModel ? ` (model riêng: ${cfg._meta.projectModel})` : ''}${ctx ? ` + context.md (${ctx.text.length} ký tự)` : ''}`);
  } else {
    console.log('  - chưa có .pe/ cho project này (pe init --project để tạo)');
  }

  // 4. Model hop le (worker chi cho :free)
  line(String(cfg.model).endsWith(':free'), `model mặc định "${cfg.model}"${String(cfg.model).endsWith(':free') ? '' : ' — worker sẽ từ chối (403)'}`);

  // 4b. Pe-worker (hang doi assign) — thong tin them, khong tinh fail
  try {
    const pend = await listPending(cfg);
    console.log(`  ${OK} pe-worker (assign) nối được — ${pend.length} việc đang chờ`);
  } catch (e) {
    console.log(`  - pe-worker (assign) chưa nối được: ${e.message}`);
  }

  // 5. Ket noi worker + auth (chi khi du thong tin)
  if (miss.length === 0) {
    try {
      const data = await apiFetch(cfg, '/api/models', { timeoutMs: 20000 });
      const n = Array.isArray(data?.data) ? data.data.length : 0;
      line(true, `worker trả lời OK (${n} model)`);
      const ids = (data.data || []).map((m) => m.id).filter(Boolean);
      line(ids.includes(cfg.model), ids.includes(cfg.model)
        ? `model "${cfg.model}" có trong danh sách worker`
        : `model "${cfg.model}" KHÔNG thấy trong danh sách worker — đổi bằng \`pe model <id>\``);
    } catch (e) {
      if (e instanceof PeError && e.kind === 'auth') {
        line(false, `sai proxy secret hoặc sai worker URL (${e.message})`);
      } else if (e instanceof PeError && e.kind === 'network') {
        line(false, `không nối được tới worker (${e.message})`);
      } else {
        line(false, `worker lỗi: ${e.message}`);
      }
    }
  } else {
    console.log('  - bỏ qua kiểm tra worker (thiếu cấu hình)');
  }

  console.log(fail === 0 ? '\nTất cả đều ổn — dùng `pe ask "xin chào"` để thử.' : `\nCó ${fail} mục cần sửa.`);
  process.exitCode = fail === 0 ? 0 : 1;
}
