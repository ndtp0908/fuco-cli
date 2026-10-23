#!/usr/bin/env node
// pe — CLI tro ly coding, noi chuyen voi pe qua fuco-agent worker.
// Buoc 0: ask / chat / init / doctor / model. Khong phu thuoc thu vien ngoai.
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
import { listSessions } from './lib/session.mjs';
import { VERSION } from './lib/version.mjs';

const HELP = `pe v${VERSION} — CLI tro ly coding (noi voi pe qua fuco-agent worker)

Dung:
  pe init                 cau hinh lan dau (worker URL + proxy secret + model)
  pe init --project       tao .pe/config.json + .pe/context.md cho project hien tai
  pe ask "cau hoi..."     hoi 1 cau (streaming), co --file/--image de dinh kem
  pe chat                 tro chuyen lien tuc + agent dung tools (mac dinh bat)
  pe do "<viec>"          giao 1 viec cho agent lam trong project (--yolo = duyet muc 3)
  pe edit <file> "<yc>"   sua 1 file theo yeu cau, xem diff roi moi ghi
  pe undo [file]          khoi phuc file ve ban truoc khi pe sua
  pe assign "<viec>"      giao viec dai cho pe qua hang doi (xem pe tasks / pe result)
  pe connect export       tao ma ket noi ma hoa de cai pe o may khac trong 1 lan dan
  pe backup / pe restore  dong goi + khoi phuc toan bo trang thai pe (file ma hoa)
  pe rules                dong bo bo nho project giua pe va Cline (.muserules)
  pe update               tu cap nhat ban .exe moi nhat
  pe chat --resume        mo lai phien chat gan nhat (phien tu luu o ~/.pe/sessions)
  pe sessions             liet ke cac phien chat da luu
  pe doctor               kiem tra cau hinh + ket noi worker
  pe model [show|list|<id>]  xem / doi model mac dinh (phai la :free)
  pe help [lenh]          xem huong dan tong, hoac chi tiet 1 lenh
  pe <lenh> --help        xem chi tiet cua lenh do

Cau hinh la TOAN CUC (~/.pe/config.json): pe init mot lan la dung duoc
o moi thu muc project. Trong 1 project co the co .pe/config.json (ghi de
model/muc duyet) + .pe/context.md (bo nho project, pe tu nap moi cau hoi). Bien moi truong ghi de config file khi co:
  PE_WORKER_URL, PE_PROXY_SECRET, PE_MODEL, PE_APPROVAL, PE_HOME
`;

const HELP_TOPICS = {
  init: `pe init — cau hinh lan dau

Wizard hoi 3 thu va luu vao ~/.pe/config.json (quyen 600):
  1. Worker URL    vi du: https://fuco-agent-proxy.xxx.workers.dev
  2. Proxy secret  chuoi MY_SECRET da dat tren worker (nhap an)
  3. Model mac dinh  phai la model :free
Cuoi wizard tu thu ket noi worker ngay.

Vi du:
  pe init`,

  ask: `pe ask — hoi 1 cau, in tra loi roi thoat

Cu phap:
  pe ask "cau hoi..." [--model <id>] [--system "..."]
           [--file <path>]... [--image <path>]...

Tuy chon:
  --model <id>     dung model khac cho rieng cau nay (phai la :free)
  --system "..."   chi dan vai tro/cach tra loi
  --file <path>    dinh kem file text/code (lap lai duoc, toi da 256 KB/file)
  --image <path>   dinh kem anh png/jpg/gif/webp (model phai co vision)
  @duong-dan       go ngay trong cau de dinh kem file/anh do

stdin:  echo "noi dung" | pe ask         -> noi dung stdin la cau hoi
        type file.cs | pe ask "cau hoi"  -> stdin gui kem nhu 1 file

Vi du:
  pe ask "giai thich async/await trong C#"
  pe ask "review file nay" --file src\\Program.cs
  pe ask "man hinh nay loi gi" --image loi.png
  pe ask "sua loi trong @src\\Helper.cs giup anh"
  type Program.cs | pe ask --system "Chi ra bug trong code nay"`,

  chat: `pe chat — tro chuyen lien tuc (REPL)

Trong chat co cac lenh:
  /help            hien danh sach lenh
  /model [id]      xem / doi model (phai la :free, co luu)
  /models          liet ke model :free
  /file <path>     dinh kem file text/code cho tin nhan TIEP THEO
  /image <path>    dinh kem anh cho tin nhan tiep theo
  /attach          xem dinh kem dang cho gui
  /clear           xoa lich su doan nay + dinh kem dang cho
  /exit            thoat
Trong cau co the go @duong-dan de dinh kem ngay file/anh do.

Vi du mot phien:
  pe> /file src\\Program.cs
  pe> review file vua gui, tim bug
  pe> loi nay o man hinh @anh-loi.png la sao`,

  doctor: `pe doctor — kiem tra cau hinh + ket noi

Kiem tra: ban Node, file config ~/.pe/config.json, model phai la :free,
va goi thu worker (phan biet duoc: sai secret / sai URL / mat mang /
model bi chan). Chay lenh nay khi pe ask bao loi.

Vi du:
  pe doctor`,

  do: `pe do — giao 1 viec cho agent lam ngay trong project

Agent tu doc/sua file, tim kiem, chay lenh trong thu muc project hien tai
bang tools (read_file/write_file/edit_file/list_files/grep/run_bash).
Moi lan ghi file deu backup truoc — pe undo khoi phuc duoc.

Cu phap:
  pe do "<viec>" [--yolo] [--approval 1|2|3]

Muc duyet:
  1  hoi truoc moi thao tac sua/chay lenh
  2  (mac dinh) doc + ghi trong project tu do, lenh la thi hoi
  3  (--yolo) tu do het, chi chan lenh pha hoai

Vi du:
  pe do "them xu ly chia cho 0 vao Calculator.cs roi build thu"
  pe do "tim cho nao dung HttpClient chua dispose" --approval 1`,

  edit: `pe edit — sua 1 file theo yeu cau, xem diff truoc khi ghi

Cu phap:
  pe edit <file> "<yeu cau>" [--yes] [--dry] [--model <id>]

  --dry    chi xem diff de xuat, khong ghi
  --yes    ghi ngay khong hoi (file cu van duoc backup)

Quy trinh: pe de xuat ban sua -> hien diff -> anh duyet -> ghi.
Khoi phuc ban cu: pe undo <file>

Vi du:
  pe edit src\\Calculator.cs "them kiem tra chia cho 0"
  pe edit src\\Helper.cs "doi ten bien cho de hieu" --dry`,

  undo: `pe undo — khoi phuc file ve ban truoc khi pe sua

Cu phap:
  pe undo [file]     khong ghi file thi khoi phuc file vua sua gan nhat

Moi lan pe ghi/sua file (edit, agent write_file/edit_file) deu tu backup
ban cu vao ~/.pe/backups nen undo luc nao cung duoc.

Vi du:
  pe undo src\\Calculator.cs
  pe undo`,

  connect: `pe connect — ma ket noi ma hoa (chuyen cau hinh sang may khac)

  pe connect              xem tom tat ket noi hien tai
  pe connect export       tao ma PE1.... (ma hoa bang mat khau ban dat)

Sang may moi:  pe init --code <ma>  (se hoi mat khau)
Khoi goi tay tung truong worker URL/secret dai ngoang. Ma chi chua cau
hinh ket noi — khong chua lich su chat hay du lieu ca nhan.`,

  update: `pe update — tu cap nhat pe.exe

  pe update           kiem tra + tai ban moi (verify SHA256 truoc khi thay)
  pe update --check   chi kiem tra, khong tai

Nguon manifest mac dinh o repo GitHub cua pe (doi bang PE_UPDATE_URL).
Chi tu thay file khi chay dang .exe (SEA); chay qua node se bao ban moi
kem huong dan cap nhat thu cong.`,

  backup: `pe backup / pe restore — mang ca "nha" sang may moi

  pe backup [--out <file.pebak>]   dong goi cau hinh + phien chat + viec da
                                   giao thanh 1 file ma hoa bang mat khau
  pe restore <file> [--force]      khoi phuc lai nguyen trang

De file backup o noi an toan (Drive). Mat khau qua prompt hoac env
PE_BACKUP_PASSWORD. Khac ma ket noi (chi cau hinh): backup gom ca lich su.`,

  rules: `pe rules — bo nho project dung chung pe + Cline

  pe rules            trang thai .pe/context.md va .muserules
  pe rules install    cai bo quy tac Cline chuan cua pe vao .muserules
  pe rules export     dong bo .pe/context.md -> .muserules
  pe rules import     dong bo .muserules -> .pe/context.md

pe tu nap ca 2 file lam ngu canh — viet 1 cho, hai cong cu deu biet.`,

  assign: `pe assign — giao viec dai cho pe qua hang doi KV

Pe nhan viec va xu ly theo chu ky (08:00-16:30, T2-T7). Phu hop viec
review/plan/research/analyze dai; viec sua code tai cho thi dung pe do.

Cu phap:
  pe assign "<viec>" [--type <loai>] [--file <path>]... [--wait] [--timeout <phut>]
  pe tasks                 xem hang doi + viec da giao
  pe result <task_id>      xem ket qua 1 viec

Loai viec: ask | review | plan | analyze | research | transform

Vi du:
  pe assign "review PR dang nhap, tim loi bao mat" --type review
  pe assign "nghien cuu ve Row Level Security cua Supabase" --type research --wait`,

  sessions: `pe sessions — cac phien chat da luu

  pe sessions              liet ke (moi nhat truoc)
  pe chat --resume         mo lai phien gan nhat
  pe chat --resume <id>    mo lai phien cu the

Phien tu luu sau moi luot chat vao ~/.pe/sessions — tat may mo lai van
tiep tuc duoc doan chat, ke ca ban tom tat ngu canh.`,

  model: `pe model — xem / doi model mac dinh

Cu phap:
  pe model             xem model dang dung (+ nguon: file hay env)
  pe model list        liet ke cac model :free tu worker
  pe model <id>        doi model mac dinh (phai ket thuc bang :free, co luu)

Vi du:
  pe model list
  pe model nvidia/nemotron-3-ultra-550b-a55b:free`,
};

async function runSessions() {
  const all = await listSessions();
  if (!all.length) {
    console.log('Chua co phien chat nao. Bat dau: pe chat');
    return;
  }
  for (const s of all.slice(0, 20)) {
    console.log(`  ${s.id}  ${new Date(s.updatedAt).toLocaleString('vi-VN')}  ${String(s.messages.length).padStart(3)} tin  ${s.title || '(chua co noi dung)'}`);
  }
  console.log('\nMo lai: pe chat --resume <id> (hoac --resume de lay phien gan nhat)');
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
    console.error(`Lenh la: "${cmd}".\n`);
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
  console.error(`Loi khong mong doi: ${e?.message || e}`);
  process.exitCode = 1;
});
