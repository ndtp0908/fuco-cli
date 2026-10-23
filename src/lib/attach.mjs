// attach.mjs — dinh kem file / anh cho ask + chat.
//
// CLI khong co nut "kep ghim": nguoi dung go duong dan, CLI doc file
// NGAY tren may cua ho roi gui kem cau hoi qua worker:
//  - file text/code: noi dung duoc goi vao phan text cua message,
//    moi file mot block co tieu de "----- File: <duong dan> -----".
//  - anh (png/jpg/jpeg/gif/webp/bmp): ma hoa base64 thanh part
//    {type:"image_url", image_url:{url:"data:..."}} — dung dinh dang
//    OpenAI-compatible ma fuco-agent app dang dung. Model phai co
//    vision moi "nhin" duoc anh.
// Nguon dinh kem: --file/--image (lap lai duoc), @duong-dan ngay trong
// cau (chi tinh khi file ton tai that), va stdin pipe (ask).
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

const MAX_TEXT_BYTES = 256 * 1024; // moi file text
const MAX_TEXT_TOTAL = 1024 * 1024; // tong cac file text + stdin
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // moi anh (gui goc, khong nen duoc o ban zero-dep)
const WARN_IMAGE_BYTES = 3 * 1024 * 1024; // lon hon muc nay thi canh bao

export function isImagePath(p) {
  return Object.prototype.hasOwnProperty.call(IMAGE_MIME, path.extname(p).toLowerCase());
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

async function statOrThrow(p, kind) {
  let st;
  try {
    st = await fs.stat(p);
  } catch {
    throw new Error(`Khong tim thay ${kind}: ${p}`);
  }
  if (!st.isFile()) throw new Error(`${kind} khong phai file: ${p}`);
  return st;
}

/** Doc 1 file text -> { label, text, bytes } */
export async function readTextAttachment(p) {
  const st = await statOrThrow(p, 'file');
  if (st.size > MAX_TEXT_BYTES) {
    throw new Error(`File qua lon (${fmtBytes(st.size)} > ${fmtBytes(MAX_TEXT_BYTES)}): ${p}. Hay chia nho file hoac gui dung phan can thiet.`);
  }
  const buf = await fs.readFile(p);
  if (buf.includes(0)) {
    throw new Error(`File nhi phan (khong phai text): ${p}. Neu la anh, dung --image.`);
  }
  return { label: p, text: buf.toString('utf8'), bytes: st.size };
}

/** Doc 1 anh -> { label, dataUrl, bytes } */
export async function readImageAttachment(p) {
  const mime = IMAGE_MIME[path.extname(p).toLowerCase()];
  if (!mime) throw new Error(`Khong ho tro dinh dang anh nay: ${p} (ho tro: png, jpg, jpeg, gif, webp, bmp)`);
  const st = await statOrThrow(p, 'anh');
  if (st.size > MAX_IMAGE_BYTES) {
    throw new Error(`Anh qua lon (${fmtBytes(st.size)} > ${fmtBytes(MAX_IMAGE_BYTES)}): ${p}. Hay giam kich thuoc anh truoc khi gui.`);
  }
  const buf = await fs.readFile(p);
  return { label: p, dataUrl: `data:${mime};base64,${buf.toString('base64')}`, bytes: st.size, large: st.size > WARN_IMAGE_BYTES };
}

/**
 * Tim @duong-dan trong cau. Chi chap nhan khi file ton tai that tren
 * dia (tranh bat nham email / ten nguoi dung). Ho tro @path va @"path
 * co dau cach". Tra ve { files, images } theo phan loai duoi file.
 */
export async function expandMentions(text) {
  const files = [];
  const images = [];
  const re = /(^|\s)@(?:"([^"]+)"|(\S+))/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const p = m[2] || m[3];
    if (!p) continue;
    let st = null;
    try { st = await fs.stat(p); } catch { /* khong ton tai -> khong phai mention */ }
    if (!st || !st.isFile()) continue;
    if (isImagePath(p)) images.push(p); else files.push(p);
  }
  return { files, images };
}

/**
 * Gom moi nguon dinh kem thanh { textBlocks, images, notes }:
 *  - textBlocks: [{label, text}] — file text + stdin (neu co)
 *  - images: [{label, dataUrl, bytes}]
 *  - notes: canh bao (anh lon...) de in ra stderr
 */
export async function collectAttachments({ files = [], images = [], stdinText = '' } = {}) {
  const textBlocks = [];
  const imageParts = [];
  const notes = [];
  let total = 0;
  for (const p of files) {
    const a = await readTextAttachment(p);
    total += a.bytes;
    if (total > MAX_TEXT_TOTAL) {
      throw new Error(`Tong dung luong file text vuot ${fmtBytes(MAX_TEXT_TOTAL)}. Hay gui it file hon.`);
    }
    textBlocks.push(a);
  }
  if (stdinText && stdinText.trim()) {
    const bytes = Buffer.byteLength(stdinText, 'utf8');
    total += bytes;
    if (total > MAX_TEXT_TOTAL) {
      throw new Error(`Tong dung luong dinh kem (ke ca stdin) vuot ${fmtBytes(MAX_TEXT_TOTAL)}.`);
    }
    textBlocks.push({ label: 'stdin', text: stdinText, bytes });
  }
  for (const p of images) {
    const a = await readImageAttachment(p);
    if (a.large) notes.push(`Anh ${p} kha lon (${fmtBytes(a.bytes)}) — gui nguyen ban co the cham/bi tu choi; nen giam xuong duoi ${fmtBytes(WARN_IMAGE_BYTES)} neu gap loi.`);
    imageParts.push(a);
  }
  return { textBlocks, images: imageParts, notes };
}

/**
 * Dung content cho 1 message user tu prompt + dinh kem.
 * Khong co anh -> string thuan (kem block file o cuoi).
 * Co anh -> mang parts OpenAI: [text, image_url...].
 */
export function buildUserContent(prompt, att) {
  let full = prompt || '';
  for (const b of att.textBlocks) {
    full += `\n\n----- File: ${b.label} -----\n${b.text}`;
  }
  if (!att.images.length) return full;
  const parts = [{ type: 'text', text: full }];
  for (const im of att.images) {
    parts.push({ type: 'image_url', image_url: { url: im.dataUrl } });
  }
  return parts;
}

/** Dong mo ta dinh kem ngan gon (hien cho user + luu vao lich su chat thay cho base64). */
export function describeAttachments(att) {
  const parts = [];
  for (const b of att.textBlocks) parts.push(`file ${b.label} (${fmtBytes(b.bytes)})`);
  for (const im of att.images) parts.push(`anh ${im.label} (${fmtBytes(im.bytes)})`);
  return parts.length ? `[Da gui kem: ${parts.join(', ')}]` : '';
}
