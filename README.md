# pe — CLI trợ lý coding

`pe` là dòng lệnh để trò chuyện với pé qua **fuco-agent worker** (Cloudflare Worker, OpenAI-compatible).
Bản hiện tại là **Bước 0**: `ask` / `chat` / `init` / `doctor` (+ `model`), có đính kèm file/ảnh. Không cần động tới worker.

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

Wizard sẽ hỏi:
1. **Worker URL** — URL của worker `fuco-agent-proxy` trên Cloudflare (ví dụ `https://xxx.workers.dev`)
2. **Proxy secret** — chuỗi `MY_SECRET` đã đặt trên worker (nhập ẩn, không hiện màn hình)
3. **Model mặc định** — phải là model `:free` (worker chặn cứng model khác, trả 403)

Lưu vào `~/.pe/config.json` (quyền 600, chỉ bạn đọc được). Cuối wizard tự thử kết nối luôn.

**Cấu hình là toàn cục**: `pe init` một lần là dùng được ở **mọi thư mục project** — cứ mở terminal ở project nào gõ `pe` là chạy, không phải cấu hình lại. Biến môi trường ghi đè config file khi có (D5):
`PE_WORKER_URL`, `PE_PROXY_SECRET`, `PE_MODEL`, `PE_APPROVAL`, `PE_HOME`

## Dùng

```bash
pe ask "giải thích đoạn code này" --model nvidia/nemotron-3-ultra-550b-a55b:free
echo "tóm tắt file X" | pe ask            # đọc prompt từ stdin
type Program.cs | pe ask "chỉ ra bug"    # stdin gửi kèm như 1 file
pe chat                                   # trò chuyện liên tục
pe doctor                                 # kiểm tra cấu hình + kết nối worker
pe model list                             # liệt kê model :free từ worker
pe model <id>                             # đổi model mặc định
pe help ask                               # hướng dẫn chi tiết 1 lệnh (có ví dụ)
pe ask --help                             # cũng vậy
```

### Đính kèm file / ảnh

CLI không có nút đính kèm — bạn gõ đường dẫn, CLI tự đọc file trên máy bạn:

```bash
pe ask "review file này" --file src\Program.cs          # file text/code (≤ 256 KB/file)
pe ask "màn hình này lỗi gì" --image loi.png            # ảnh png/jpg/gif/webp
pe ask "sửa lỗi trong @src\Helper.cs giúp"              # @đường-dẫn ngay trong câu
```

Trong `pe chat`: `/file <path>` và `/image <path>` gắn file cho tin nhắn **tiếp theo**, `/attach` xem file đang chờ, hoặc gõ `@đường-dẫn` ngay trong câu.

Lưu ý ảnh: model phải **có vision**. Model mặc định (Nemotron 3 Ultra) không nhận ảnh — dùng model vision `:free`, ví dụ `nvidia/nemotron-3.5-super-vl:free`:
`pe ask "trong ảnh có chữ gì" --image anh.png --model nvidia/nemotron-3.5-super-vl:free`
Ảnh gửi nguyên bản (bản zero-dep không nén được) — ảnh trên ~3 MB sẽ có cảnh báo, trên 10 MB bị từ chối.

Lệnh trong `pe chat`: `/help` `/model [id]` `/models` `/file` `/image` `/attach` `/clear` `/exit`

## Kiểm tra

```bash
npm test   # 27 ca: config, env override, mock worker (sai secret, model non-free, mất mạng),
           # đính kèm file/ảnh/@mention/stdin, help chi tiết, chat /file, stdin mở không treo
```

## Thiết kế (đã chốt D1–D7)

- Tên lệnh `pe` (D1); repo riêng `ndtp0908/fuco-cli` (D7)
- Bước 0 chỉ chat/ask — `pe assign` (giao việc dài qua hàng đợi KV) để bước sau (D2)
- `approval` mặc định 2: tự sửa file trong project, hỏi khi chạy shell nguy hiểm (D3) — có sẵn trong config, bước agent mới dùng tới
- Model mặc định = model free như app, đổi bằng `/model` hoặc `pe model` (D4)
- Đóng gói 1 file `.exe` bằng Node SEA (D6) — code đã viết dạng ESM zero-deps để bước đóng gói đơn giản

## Lộ trình

- **Bước 1:** agent đọc/sửa file trong project (approval level 1–3)
- **Bước 2:** `pe assign` — giao việc dài cho pé qua hàng đợi KV
- **Bước 3:** đóng gói `.exe` một file bằng Node SEA
