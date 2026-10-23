// `pe connect` — xem tom tat ket noi; `pe connect export` — tao ma ket noi
// ma hoa (Goi A1) de dan sang may khac: ben do chay `pe init --code <ma>`.
import { loadConfig } from '../lib/config.mjs';
import { encodeConnectCode } from '../lib/connect.mjs';
import { askHidden } from './init.mjs';

export async function runConnect(args = []) {
  const cfg = await loadConfig();
  if (args[0] === 'export') {
    if (!cfg.workerUrl || !cfg.proxySecret) {
      console.error('May nay chua co cau hinh de xuat (thieu workerUrl/proxySecret). Chay `pe init` truoc.');
      process.exitCode = 2;
      return;
    }
    const password = process.env.PE_CONNECT_PASSWORD || (await askHidden('Dat mat khau cho ma ket noi (it nhat 4 ky tu)'));
    let code;
    try {
      code = encodeConnectCode({
        workerUrl: cfg.workerUrl,
        peWorkerUrl: cfg.peWorkerUrl,
        proxySecret: cfg.proxySecret,
        model: cfg.model,
        approval: cfg.approval,
      }, password);
    } catch (e) {
      console.error(e.message);
      process.exitCode = 2;
      return;
    }
    console.log('\nMa ket noi cua ban (copy toan bo 1 dong):\n');
    console.log(code);
    console.log('\nSang may moi chi can chay:  pe init --code <dan-ma-vao-day>');
    console.log('(se hoi mat khau vua dat). Ma chi chua cau hinh ket noi, khong chua lich su chat.');
    return;
  }
  console.log('Ket noi hien tai:');
  console.log(`  Worker chinh : ${cfg.workerUrl || '(chua co)'}`);
  console.log(`  Pe-worker    : ${cfg.peWorkerUrl}`);
  console.log(`  Model        : ${cfg.model}`);
  console.log(`  Secret       : ${cfg.proxySecret ? 'da co (dang an)' : '(chua co)'}`);
  console.log('\nTao ma de chuyen sang may khac: pe connect export');
}
