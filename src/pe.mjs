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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const VERSION = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;

const HELP = `pe v${VERSION} — CLI tro ly coding (noi voi pe qua fuco-agent worker)

Dung:
  pe init                 cau hinh lan dau (worker URL + proxy secret + model)
  pe init --project       tao .pe/config.json + .pe/context.md cho project hien tai
  pe ask "cau hoi..."     hoi 1 cau (streaming), co --file/--image de dinh kem
  pe chat                 tro chuyen lien tuc + agent dung tools (mac dinh bat)
  pe do "<viec>"          giao 1 viec cho agent lam trong project (--yolo = duyet muc 3)
  pe edit <file> "<yc>"   sua 1 file theo yeu cau, xem diff roi moi ghi
  pe undo [file]          khoi phuc file ve ban truoc khi pe sua
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

  model: `pe model — xem / doi model mac dinh

Cu phap:
  pe model             xem model dang dung (+ nguon: file hay env)
  pe model list        liet ke cac model :free tu worker
  pe model <id>        doi model mac dinh (phai ket thuc bang :free, co luu)

Vi du:
  pe model list
  pe model nvidia/nemotron-3-ultra-550b-a55b:free`,
};

const COMMANDS = {
  init: runInit,
  ask: runAsk,
  chat: runChat,
  do: runDo,
  edit: runEdit,
  undo: runUndo,
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
