# pe — CLI trợ lý coding

`pe` là dòng lệnh để trò chuyện với pé qua **fuco-agent worker** (Cloudflare Worker, OpenAI-compatible).
Hiện tại đã có: **Bước 0** (`ask`/`chat`/`init`/`doctor`/`model` + đính kèm file/ảnh) và **Bước 1** (agent dùng tools trong project: `pe do`, `pe edit`, `pe undo`), kèm streaming, bộ nhớ theo project.

## Cài đặt

Yêu cầu Node.js ≥ 18. Không phụ thuộc thư viện ngoài.

```bash
git clone https://github.com/ndtp0908/fuco-cli.git
cd fuco-cli
npm link        # để gọi `pe` ở mọi nơi (hoặc: node src/pe.mjs ...)
```

## Cấu hình lần đầu

```bash
pe init
```

Wizard hỏi Worker URL, **Proxy secret** (`MY_SECRET` trên worker, nhập ẩn) và model mặc định (phải là `:free`), lưu vào `~/.pe/config.json` (quyền 600) rồi tự thử kết nối.

**Cấu hình là toàn cục**: init một lần, dùng ở **mọi thư mục project**. Biến môi trường ghi đè khi có: `PE_WORKER_URL`, `PE_PROXY_SECRET`, `PE_MODEL`, `PE_APPROVAL`, `PE_HOME`.

### Cấu hình + bộ nhớ theo project (tuỳ chọn)

```bash
cd my-project
pe init --project
```

Tạo thư mục `.pe/` trong project:
- `.pe/config.json` — ghi đè `model` và mức duyệt riêng cho project này (secret không bao giờ đọc từ project).
- `.pe/context.md` — **bộ nhớ project**: viết vào đó stack, quy ước code, lệnh build/test... Pe tự nạp vào mọi câu hỏi khi bạn đứng trong project (kể cả thư mục con). Thứ tự ưu tiên: biến môi trường > `.pe/config.json` > `~/.pe/config.json`.

## Dùng

```bash
pe ask "giải thích đoạn code này"          # trả lời STREAMING, chữ chảy trực tiếp
pe chat                                     # trò chuyện liên tục (có agent)
pe do "thêm xử lý chia cho 0 vào Calculator.cs rồi build thử"
pe edit src\Calculator.cs "thêm kiểm tra chia cho 0"   # xem diff, duyệt mới ghi
pe undo src\Calculator.cs                   # quay lui bản trước khi pe sửa
pe doctor                                   # kiểm tra cấu hình + kết nối worker
pe model list                               # liệt kê model :free
pe help do                                  # hướng dẫn chi tiết từng lệnh
```

### Đính kèm file / ảnh (ask & chat)

```bash
pe ask "review file này" --file src\Program.cs        # ≤ 256 KB/file
pe ask "màn hình này lỗi gì" --image loi.png          # cần model vision :free
pe ask "sửa lỗi trong @src\Helper.cs giúp"            # @đường-dẫn ngay trong câu
type Program.cs | pe ask "chỉ ra bug"                 # stdin gửi kèm như 1 file
```

Trong `pe chat`: `/file`, `/image` gắn cho tin nhắn tiếp theo, `/attach` xem đang chờ.
Model mặc định không nhận ảnh — dùng model vision `:free`, ví dụ `nvidia/nemotron-3.5-super-vl:free` (CLI tự gợi ý khi dùng nhầm).

### Agent & mức duyệt (Bước 1)

`pe do "<việc>"` và `pe chat` (mặc định bật tools, tắt bằng `/tools off`) cho model dùng tools ngay trong project: `read_file`, `write_file`, `edit_file`, `list_files`, `grep`, `run_bash`. Model gọi tool qua native tool-calls hoặc khối JSON (tự fallback). Mọi thao tác bị khoá trong thư mục project; mỗi lần ghi file đều **backup trước** vào `~/.pe/backups` nên `pe undo` khôi phục được.

Mức duyệt (`pe do --approval`, `/approval` trong chat, hoặc `approval` trong config):
- **1** — hỏi trước mọi thao tác sửa/chạy lệnh
- **2** — (mặc định) đọc + ghi trong project tự do, lệnh shell lạ thì hỏi, lệnh chỉ-xem (git status, ls...) tự chạy
- **3** — `--yolo`: tự do hết, chỉ chặn cứng lệnh phá hoại (format, rm -rf /, ...)

Trong chat còn có: `/tools on|off`, `/approval 1|2|3`, `/undo [file]`, `/model`, `/models`, `/clear`, `/help`.

`pe edit` là đường ngắn cho quy trình code công ty: pe đề xuất bản sửa → hiện **diff** → bạn duyệt → mới ghi (có backup). `--dry` chỉ xem diff, `--yes` ghi ngay không hỏi.

## Kiểm tra

```bash
npm test   # 36 ca: config/env/project override, mock worker (sai secret, model non-free,
           # mất mạng), streaming SSE, đính kèm file/ảnh/@mention/stdin, help chi tiết,
           # pe edit + undo, agent pe do (đọc→sửa file), glob list_files, chat đa-tool JSON
```

## Thiết kế (đã chốt D1–D7)

- Tên lệnh `pe` (D1); repo riêng `ndtp0908/fuco-cli` (D7)
- `pe assign` (giao việc dài qua hàng đợi KV) để Bước 2 (D2)
- Mức duyệt mặc định 2 (D3) — đã dùng thật từ Bước 1
- Model mặc định = model free như app, đổi bằng `/model` hoặc `pe model` (D4)
- Secret ở `~/.pe/config.json` qua wizard, env ghi đè (D5)
- Đóng gói 1 file `.exe` bằng Node SEA (D6) — Bước 3

## Lộ trình

- ✅ Bước 0: ask/chat/init/doctor/model (+ đính kèm, help chi tiết, streaming, bộ nhớ project)
- ✅ Bước 1: agent + tools, `pe do`, `pe edit`/`pe undo`
- ⬜ Bước 2: lưu phiên chat để mở lại + tự rút gọn ngữ cảnh, `pe assign`
- ⬜ Bước 3: đóng gói `.exe` một file bằng Node SEA
