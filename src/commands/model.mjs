// `pe model` — xem / doi / liet ke model.
import { loadConfig, saveConfig } from '../lib/config.mjs';
import { listModelsDetailed } from '../lib/api.mjs';

export async function runModel(args) {
  const cfg = await loadConfig();
  const sub = args[0];

  if (!sub || sub === 'show') {
    console.log(`model hien tai: ${cfg.model}`);
    console.log(`model du phong: ${(cfg.fallbackModels || []).join(', ') || '(khong co)'} (tu chuyen khi model chinh bi nghen)`);
    console.log(`(doi bang: pe model <id>  |  liet ke: pe model list [--vision])`);
    return;
  }
  if (sub === 'list') {
    const visionOnly = args.includes('--vision');
    try {
      const all = (await listModelsDetailed(cfg)).filter((m) => m.id.endsWith(':free'));
      const ids = visionOnly ? all.filter((m) => m.vision) : all;
      if (!ids.length) console.log(visionOnly ? '(khong co model vision :free nao)' : '(worker khong tra ve model :free nao)');
      else {
        console.log(ids.map((m) => m.id + (m.vision ? '  [vision]' : '')).join('\n'));
        console.log(`\nTong: ${ids.length} model${visionOnly ? ' vision' : ''} :free. Model du phong khi bi nghen: ${(cfg.fallbackModels || []).join(', ') || '(chua dat)'}`);
      }
    } catch (e) {
      console.error(`Loi: ${e.message}`);
      process.exitCode = 1;
    }
    return;
  }
  const id = sub.trim();
  if (!id.endsWith(':free')) {
    console.error(`Tu choi: worker chi cho phep model ket thuc bang ":free" (ban nhap "${id}").`);
    process.exitCode = 2;
    return;
  }
  await saveConfig({ workerUrl: cfg.workerUrl, peWorkerUrl: cfg.peWorkerUrl, proxySecret: cfg.proxySecret, model: id, approval: cfg.approval });
  console.log(`Da doi model mac dinh thanh ${id}`);
}
