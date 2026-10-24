// `pe model` — xem / doi / liet ke model.
import { loadConfig, saveConfig } from '../lib/config.mjs';
import { listModelsDetailed } from '../lib/api.mjs';

export async function runModel(args) {
  const cfg = await loadConfig();
  const sub = args[0];

  if (!sub || sub === 'show') {
    console.log(`model hiện tại: ${cfg.model}`);
    console.log(`model dự phòng: ${(cfg.fallbackModels || []).join(', ') || '(không có)'} (tự chuyển khi model chính bị nghẽn)`);
    console.log(`(đổi bằng: pe model <id>  |  liệt kê: pe model list [--vision])`);
    return;
  }
  if (sub === 'list') {
    const visionOnly = args.includes('--vision');
    try {
      const all = (await listModelsDetailed(cfg)).filter((m) => m.id.endsWith(':free'));
      const ids = visionOnly ? all.filter((m) => m.vision) : all;
      if (!ids.length) console.log(visionOnly ? '(không có model vision :free nào)' : '(worker không trả về model :free nào)');
      else {
        console.log(ids.map((m) => m.id + (m.vision ? '  [vision]' : '')).join('\n'));
        console.log(`\nTổng: ${ids.length} model${visionOnly ? ' vision' : ''} :free. Model dự phòng khi bị nghẽn: ${(cfg.fallbackModels || []).join(', ') || '(chưa đặt)'}`);
      }
    } catch (e) {
      console.error(`Lỗi: ${e.message}`);
      process.exitCode = 1;
    }
    return;
  }
  const id = sub.trim();
  if (!id.endsWith(':free')) {
    console.error(`Từ chối: worker chỉ cho phép model kết thúc bằng ":free" (bạn nhập "${id}").`);
    process.exitCode = 2;
    return;
  }
  await saveConfig({ workerUrl: cfg.workerUrl, peWorkerUrl: cfg.peWorkerUrl, proxySecret: cfg.proxySecret, model: id, approval: cfg.approval });
  console.log(`Đã đổi model mặc định thành ${id}`);
}
