// `pe connect` — xem tom tat ket noi; `pe connect export` — tao ma ket noi
// ma hoa (Goi A1) de dan sang may khac: ben do chay `pe init --code <ma>`.
import { loadConfig } from '../lib/config.mjs';
import { encodeConnectCode } from '../lib/connect.mjs';
import { askHidden } from './init.mjs';

export async function runConnect(args = []) {
  const cfg = await loadConfig();
  if (args[0] === 'export') {
    if (!cfg.workerUrl || !cfg.proxySecret) {
      console.error('Máy này chưa có cấu hình để xuất (thiếu workerUrl/proxySecret). Chạy `pe init` trước.');
      process.exitCode = 2;
      return;
    }
    const password = process.env.PE_CONNECT_PASSWORD || (await askHidden('Đặt mật khẩu cho mã kết nối (ít nhất 4 ký tự)'));
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
    console.log('\nMã kết nối của bạn (copy toàn bộ 1 dòng):\n');
    console.log(code);
    console.log('\nSang máy mới chỉ cần chạy:  pe init --code <dán-mã-vào-đây>');
    console.log('(sẽ hỏi mật khẩu vừa đặt). Mã chỉ chứa cấu hình kết nối, không chứa lịch sử chat.');
    return;
  }
  console.log('Kết nối hiện tại:');
  console.log(`  Worker chính : ${cfg.workerUrl || '(chưa có)'}`);
  console.log(`  Pe-worker    : ${cfg.peWorkerUrl}`);
  console.log(`  Model        : ${cfg.model}`);
  console.log(`  Secret       : ${cfg.proxySecret ? 'đã có (đang ẩn)' : '(chưa có)'}`);
  console.log('\nTạo mã để chuyển sang máy khác: pe connect export');
}
