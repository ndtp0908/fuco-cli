#!/usr/bin/env node
// pe — CLI trợ lý coding, nói chuyện với pé qua fuco-agent worker.
// Không phụ thuộc thư viện ngoài (zero-dependency).
import { runAsk } from './commands/ask.mjs';
import { runChat } from './commands/chat.mjs';
import { runInit } from './commands/init.mjs';
import { runDoctor } from './commands/doctor.mjs';
import { runModel } from './commands/model.mjs';
import { runEdit, runUndo } from './commands/edit.mjs';
import { runDo } from './commands/do.mjs';
import { runAssign, runTasks, runResult } from './commands/assign.mjs';
import { runConnect } from './commands/connect.mjs';
import { runUpdate } from './commands/update.mjs';
import { runRules } from './commands/rules.mjs';
import { runBackup, runRestore } from './commands/backup.mjs';
import { runLessons } from './commands/lessons.mjs';
import { runConfig } from './commands/config.mjs';
import { listSessions, deleteSession } from './lib/session.mjs';
import { VERSION } from './lib/version.mjs';

const HELP = `pe v${VERSION} — CLI trợ lý coding (nói với pé qua fuco-agent worker)

Dùng:
  pe init                 cấu hình lần đầu (worker URL + proxy secret + model)
  pe init --project       tạo .pe/config.json + .pe/context.md cho project hiện tại
  pe ask "câu hỏi..."     hỏi 1 câu (streaming), có --file/--image để đính kèm
  pe chat                 trò chuyện liên tục + agent dùng tools (mặc định bật)
  pe do "<việc>"          giao 1 việc cho agent làm trong project (--yolo = duyệt mức 3)
  pe edit <file> "<yc>"   sửa 1 file theo yêu cầu, xem diff rồi mới ghi
  pe undo [file]          khôi phục file về bản trước khi pé sửa
  pe assign "<việc>"      giao việc dài cho pé qua hàng đợi (xem pe tasks / pe result)
  pe connect export       tạo mã kết nối mã hoá để cài pé ở máy khác trong 1 lần dán
  pe backup / pe restore  đóng gói + khôi phục toàn bộ trạng thái pé (file mã hoá)
  pe rules                đồng bộ bộ nhớ project giữa pé và Cline (.muserules)
  pe lessons              bài học kinh nghiệm từ các lỗi đã gặp (xem/ghi tay/xoá)
  pe config               quản lý toàn bộ cấu hình trong CLI (xem/sửa/mở file)
  pe update               tự cập nhật bản .exe mới nhất
  pe chat --resume        mở lại phiên chat gần nhất (phiên tự lưu ở ~/.pe/sessions)
  pe sessions             liệt kê các phiên chat đã lưu
  pe doctor               kiểm tra cấu hình + kết nối worker
  pe model [show|list|<id>]  xem / đổi model mặc định (phải là :free)
  pe help [lệnh]          xem hướng dẫn tổng, hoặc chi tiết 1 lệnh
  pe <lệnh> --help        xem chi tiết của lệnh đó

Cấu hình là TOÀN CỤC (~/.pe/config.json): pe init một lần là dùng được
ở mọi thư mục project. Trong 1 project có thể có .pe/config.json (ghi đè
model/mức duyệt) + .pe/context.md (bộ nhớ project, pé tự nạp mỗi câu hỏi). Biến môi trường ghi đè config file khi có:
  PE_WORKER_URL, PE_PROXY_SECRET, PE_MODEL, PE_APPROVAL, PE_HOME

Quản lý cấu hình không cần mò file: pe config (xem tất cả), pe config set, pe config edit.
`;

const HELP_TOPICS = {
  init: `pe init — cấu hình lần đầu

Wizard hỏi 3 thứ và lưu vào ~/.pe/config.json (quyền 600):
  1. Worker URL    ví dụ: https://fuco-agent-proxy.xxx.workers.dev
  2. Proxy secret  chuỗi MY_SECRET đã đặt trên worker (nhập ẩn)
  3. Model mặc định  phải là model :free
Cuối wizard tự thử kết nối worker ngay.

Ví dụ:
  pe init`,

  ask: `pe ask — hỏi 1 câu, in trả lời rồi thoát

Cú pháp:
  pe ask "câu hỏi..." [--model <id>] [--system "..."]
           [--file <path>]... [--image <path>]... [--web]

Tuỳ chọn:
  --model <id>     dùng model khác cho riêng câu này (phải là :free)
  --system "..."   chỉ dẫn vai trò/cách trả lời
  --file <path>    đính kèm file text/code (lặp lại được, tối đa 256 KB/file)
  --image <path>   đính kèm ảnh png/jpg/gif/webp (model phải có vision)
  --web            worker tự tìm kiếm web + chèn kết quả/nguồn vào câu trả lời
  @đường-dẫn       gõ ngay trong câu để đính kèm file/ảnh đó

stdin:  echo "nội dung" | pe ask         -> nội dung stdin là câu hỏi
        type file.cs | pe ask "câu hỏi"  -> stdin gửi kèm như 1 file

Ví dụ:
  pe ask "giải thích async/await trong C#"
  pe ask "review file này" --file src\\Program.cs
  pe ask "màn hình này lỗi gì" --image loi.png
  pe ask "sửa lỗi trong @src\\Helper.cs giúp anh"
  type Program.cs | pe ask --system "Chỉ ra bug trong code này"`,

  chat: `pe chat — trò chuyện liên tục (REPL)

Trong chat có các lệnh:
  /help            hiện danh sách lệnh
  /model [id]      xem / đổi model (phải là :free, có lưu)
  /models          liệt kê model :free
  /file <path>     đính kèm file text/code cho tin nhắn TIẾP THEO
  /image <path>    đính kèm ảnh cho tin nhắn tiếp theo
  /attach          xem đính kèm đang chờ gửi
  /web [on|off]    bật/tắt tìm kiếm web (mặc định tắt; hoặc mở bằng: pe chat --web)
  /lesson <nd>     ghi tay 1 bài học kinh nghiệm (lưu ngay)
  /clear           xoá lịch sử đoạn này + đính kèm đang chờ
  /exit            thoát
Trong câu có thể gõ @đường-dẫn để đính kèm ngay file/ảnh đó.

Ví dụ một phiên:
  pe> /file src\\Program.cs
  pe> review file vừa gửi, tìm bug
  pe> lỗi này ở màn hình @anh-loi.png là sao`,

  doctor: `pe doctor — kiểm tra cấu hình + kết nối

Kiểm tra: bản Node, file config ~/.pe/config.json, model phải là :free,
và gọi thử worker (phân biệt được: sai secret / sai URL / mất mạng /
model bị chặn). Chạy lệnh này khi pe ask báo lỗi.

Ví dụ:
  pe doctor`,

  do: `pe do — giao 1 việc cho agent làm ngay trong project

Agent tự đọc/sửa file, tìm kiếm, chạy lệnh trong thư mục project hiện tại
bằng tools (read_file/write_file/edit_file/list_files/grep/run_bash).
Mỗi lần ghi file đều backup trước — pe undo khôi phục được.

Cú pháp:
  pe do "<việc>" [--yolo] [--approval 1|2|3] [--web] [--json] [--verify "<lệnh>"]
  (--web: worker tìm web + chèn nguồn cho câu hỏi gốc trước khi agent chạy)
  (--verify: làm xong tự chạy lệnh kiểm chứng, vd "npm run build" hay
   "npm test"; FAIL thì đưa lỗi về cho agent sửa tiếp, tối đa 2 vòng)

Tự chữa (v0.9): nếu model định kết thúc mà vẫn còn lỗi tool chưa xử lý,
pé không cho kết thúc — tự thêm 1 lượt yêu cầu sửa tiếp cho xong.
Lỗi đã sửa xong trong lúc làm sẽ được rút thành bài học (pe lessons).

Mức duyệt:
  1  hỏi trước mỗi thao tác sửa/chạy lệnh
  2  (mặc định) đọc + ghi trong project tự do, lệnh lạ thì hỏi
  3  (--yolo) tự do hết, chỉ chặn lệnh phá hoại

Ví dụ:
  pe do "thêm xử lý chia cho 0 vào Calculator.cs rồi build thử"
  pe do "sửa lỗi build" --verify "npm run build"
  pe do "tìm chỗ nào dùng HttpClient chưa dispose" --approval 1`,

  edit: `pe edit — sửa 1 file theo yêu cầu, xem diff trước khi ghi

Cú pháp:
  pe edit <file> "<yêu cầu>" [--yes] [--dry] [--model <id>]

Nếu model trả về sai định dạng (không có khối mã), trả nguyên file gốc
(chưa sửa gì) hoặc lỗi tạm thời: pé tự thử lại 1 lần, mớm lại lỗi cụ thể
cho model trả lời lại đúng định dạng (v0.9).

  --dry    chỉ xem diff đề xuất, không ghi
  --yes    ghi ngay không hỏi (file cũ vẫn được backup)

Quy trình: pé đề xuất bản sửa -> hiện diff -> anh duyệt -> ghi.
Khôi phục bản cũ: pe undo <file>

Ví dụ:
  pe edit src\\Calculator.cs "thêm kiểm tra chia cho 0"
  pe edit src\\Helper.cs "đổi tên biến cho dễ hiểu" --dry`,

  undo: `pe undo — khôi phục file về bản trước khi pé sửa

Cú pháp:
  pe undo [file]     không ghi file thì khôi phục file vừa sửa gần nhất

Mỗi lần pé ghi/sửa file (edit, agent write_file/edit_file) đều tự backup
bản cũ vào ~/.pe/backups nên undo lúc nào cũng được.

Ví dụ:
  pe undo src\\Calculator.cs
  pe undo`,

  connect: `pe connect — mã kết nối mã hoá (chuyển cấu hình sang máy khác)

  pe connect              xem tóm tắt kết nối hiện tại
  pe connect export       tạo mã PE1.... (mã hoá bằng mật khẩu bạn đặt)

Sang máy mới:  pe init --code <mã>  (sẽ hỏi mật khẩu)
Khỏi gõ tay từng trường worker URL/secret dài ngoằng. Mã chỉ chứa cấu
hình kết nối — không chứa lịch sử chat hay dữ liệu cá nhân.`,

  update: `pe update — tự cập nhật pe.exe

  pe update           kiểm tra + tải bản mới (verify SHA256 trước khi thay)
  pe update --check   chỉ kiểm tra, không tải

Nguồn manifest mặc định ở repo GitHub của pé (đổi bằng PE_UPDATE_URL).
Chỉ tự thay file khi chạy dạng .exe (SEA); chạy qua node sẽ báo bản mới
kèm hướng dẫn cập nhật thủ công.`,

  backup: `pe backup / pe restore — mang cả "nhà" sang máy mới

  pe backup [--out <file.pebak>]   đóng gói cấu hình + phiên chat + việc đã
                                   giao thành 1 file mã hoá bằng mật khẩu
  pe restore <file> [--force]      khôi phục lại nguyên trạng

Để file backup ở nơi an toàn (Drive). Mật khẩu qua prompt hoặc env
PE_BACKUP_PASSWORD. Khác mã kết nối (chỉ cấu hình): backup gồm cả lịch sử.`,

  lessons: `pe lessons — bài học kinh nghiệm từ các lỗi đã gặp (v0.8)

Cơ chế: khi agent phạm lỗi trong pe do / pe chat nhưng tự sửa xong,
pé tự rút bài học ngắn (Lỗi / Gốc rễ / Lần sau), hỏi anh duyệt rồi mới
lưu vào .pe/lessons.md (project) hoặc ~/.pe/lessons.md (toàn cục).
Các phiên sau bài học được nạp lại vào system prompt để tránh lặp lại;
bài học gặp lại lần nữa sẽ tăng bộ đếm (x2, x3...) và được ưu tiên hơn.

  pe lessons                        liệt kê bài học (project + toàn cục)
  pe lessons add "<nd>" [--global]  ghi tay 1 bài học (lưu ngay)
  pe lessons rm <project|global> <số>  xoá 1 bài học

Trong pe chat: /lesson <nội dung> để ghi tay ngay trong lúc chat.
Đồng bộ sang Cline: pe rules export (kèm theo section bài học).`,

  config: `pe config — quản lý toàn bộ cấu hình ngay trong CLI (v0.10)

  pe config                  tổng quan: giá trị hiệu lực của từng khoá +
                             nguồn (env / project / file / mặc định), trạng
                             thái context.md, lessons.md, .muserules
  pe config get <khoá>       xem 1 giá trị (secret luôn được che)
  pe config set <khoá> <giá trị>            ghi vào config toàn cục
  pe config set --project <khoá> <giá trị>  ghi vào .pe/config.json của
                             project (chỉ model + approval)
  pe config edit [global|project|context|lessons|rules]
                             mở đúng file bằng editor để sửa tay
                             ($PE_EDITOR / $EDITOR / notepad / vi)
  pe config path             in mọi đường dẫn quan trọng

Khoá toàn cục: workerUrl, peWorkerUrl, proxySecret, model, approval,
fallbackModels, updateUrl.

Ví dụ:
  pe config set model google/gemma-4-31b-it:free
  pe config set --project approval 3
  pe config edit context`,

  rules: `pe rules — bộ nhớ project dùng chung pé + Cline

  pe rules            trạng thái .pe/context.md và .muserules
  pe rules install    cài bộ quy tắc Cline chuẩn của pé vào .muserules
  pe rules export     đồng bộ .pe/context.md -> .muserules
  pe rules import     đồng bộ .muserules -> .pe/context.md

pé tự nạp cả 2 file làm ngữ cảnh — viết 1 chỗ, hai công cụ đều biết.`,

  assign: `pe assign — giao việc dài cho pé qua hàng đợi KV

Pé nhận việc và xử lý theo chu kỳ (08:00-21:30, T2-T7). Phù hợp việc
review/plan/research/analyze dài; việc sửa code tại chỗ thì dùng pe do.

Cú pháp:
  pe assign "<việc>" [--type <loại>] [--file <path>]... [--wait] [--timeout <phút>]
  pe tasks                 xem hàng đợi + việc đã giao
  pe result <task_id>      xem kết quả 1 việc

Loại việc: ask | review | plan | analyze | research | transform

Ví dụ:
  pe assign "review PR đăng nhập, tìm lỗi bảo mật" --type review
  pe assign "nghiên cứu về Row Level Security của Supabase" --type research --wait`,

  sessions: `pe sessions — các phiên chat đã lưu

  pe sessions              liệt kê (mới nhất trước)
  pe sessions rm <id>      xoá 1 phiên theo id
  pe chat --resume         mở lại phiên gần nhất
  pe chat --resume <id>    mở lại phiên cụ thể

Phiên tự lưu sau mỗi lượt chat vào ~/.pe/sessions — tắt máy mở lại vẫn
tiếp tục được đoạn chat, kể cả bản tóm tắt ngữ cảnh.`,

  model: `pe model — xem / đổi model mặc định

Cú pháp:
  pe model             xem model đang dùng (+ nguồn: file hay env)
  pe model list        liệt kê các model :free từ worker
  pe model <id>        đổi model mặc định (phải kết thúc bằng :free, có lưu)

Ví dụ:
  pe model list
  pe model nvidia/nemotron-3-ultra-550b-a55b:free`,
};

async function runSessions(args = []) {
  if (args[0] === 'rm') {
    const id = args[1];
    if (!id) {
      console.error('Dùng: pe sessions rm <id> — xem id bằng `pe sessions`.');
      process.exitCode = 2;
      return;
    }
    const s = (await listSessions()).find((x) => x.id === id);
    if (!s) {
      console.error(`Không tìm thấy phiên "${id}". Chạy \`pe sessions\` để xem danh sách.`);
      process.exitCode = 2;
      return;
    }
    const okRm = await deleteSession(id);
    console.log(okRm ? `Đã xoá phiên ${id} (${s.title || 'chưa có nội dung'}).` : `Không xoá được phiên "${id}".`);
    if (!okRm) process.exitCode = 1;
    return;
  }
  const all = await listSessions();
  if (!all.length) {
    console.log('Chưa có phiên chat nào. Bắt đầu: pe chat');
    return;
  }
  for (const s of all.slice(0, 20)) {
    console.log(`  ${s.id}  ${new Date(s.updatedAt).toLocaleString('vi-VN')}  ${String(s.messages.length).padStart(3)} tin  ${s.title || '(chưa có nội dung)'}`);
  }
  console.log('\nMở lại: pe chat --resume <id> (hoặc --resume để lấy phiên gần nhất). Xoá phiên: pe sessions rm <id>');
}

const COMMANDS = {
  init: runInit,
  ask: runAsk,
  chat: runChat,
  do: runDo,
  edit: runEdit,
  undo: runUndo,
  assign: runAssign,
  connect: runConnect,
  backup: runBackup,
  restore: runRestore,
  update: runUpdate,
  rules: runRules,
  lessons: runLessons,
  config: runConfig,
  tasks: runTasks,
  result: runResult,
  sessions: runSessions,
  doctor: runDoctor,
  model: runModel,
};

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' && !rest.length) {
    if (cmd === 'help' && rest.length && HELP_TOPICS[rest[0]]) {
      console.log(HELP_TOPICS[rest[0]]);
      return;
    }
    console.log(HELP);
    return;
  }
  if (cmd === 'help') {
    const topic = rest[0];
    if (topic && HELP_TOPICS[topic]) console.log(HELP_TOPICS[topic]);
    else console.log(HELP);
    return;
  }
  if (cmd === '--version' || cmd === '-v') {
    console.log(VERSION);
    return;
  }
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error(`Lệnh lạ: "${cmd}".\n`);
    console.log(HELP);
    process.exitCode = 2;
    return;
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(HELP_TOPICS[cmd]);
    return;
  }
  await fn(rest);
}

main().catch((e) => {
  console.error(`Lỗi không mong đợi: ${e?.message || e}`);
  process.exitCode = 1;
});
