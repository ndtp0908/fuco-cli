// `pe model` — xem / doi / liet ke model.
import { loadConfig, saveConfig } from '../lib/config.mjs';
import { freeOnly, listModels } from '../lib/api.mjs';

export async function runModel(args) {
  const cfg = await loadConfig();
  const sub = args[0];

  if (!sub || sub === 'show') {
    console.log(`model hien tai: ${cfg.model}`);
    console.log(`(doi bang: pe model <id>  |  liet ke: pe model list)`);
    return;
  }
  if (sub === 'list') {
    try {
      const ids = freeOnly(await listModels(cfg));
      if (!ids.length) console.log('(worker khong tra ve model :free nao)');
      else console.log(ids.join('\n'));
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
