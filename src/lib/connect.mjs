// Ma ket noi (Goi A1): dong goi cau hinh pe (worker URL, pe-worker URL,
// secret, model) thanh 1 chuoi ma hoa bang mat khau de dan sang may khac.
// Thuat toan cung ho voi ket cua app: PBKDF2-HMAC-SHA256 + AES-256-CBC + HMAC.
// Dinh dang: PE1.<base64url({salt, iv, data, mac})>
import crypto from 'node:crypto';

const PREFIX = 'PE1.';
const ITER = 50000;

function derive(password, salt) {
  return crypto.pbkdf2Sync(String(password), salt, ITER, 64, 'sha256');
}

/** Ma hoa object cau hinh -> chuoi ma ket noi. */
export function encodeConnectCode(obj, password) {
  if (!password || String(password).length < 4) {
    throw new Error('Mat khau phai co it nhat 4 ky tu.');
  }
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const keyMat = derive(password, salt);
  const encKey = keyMat.subarray(0, 32);
  const macKey = keyMat.subarray(32, 64);
  const plain = Buffer.from(JSON.stringify(obj), 'utf8');
  const cipher = crypto.createCipheriv('aes-256-cbc', encKey, iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  const mac = crypto.createHmac('sha256', macKey).update(Buffer.concat([salt, iv, data])).digest();
  const packed = JSON.stringify({
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    data: data.toString('base64'),
    mac: mac.toString('base64'),
  });
  return PREFIX + Buffer.from(packed, 'utf8').toString('base64url');
}

/** Giai ma chuoi ket noi -> object cau hinh. Nem loi neu sai mat khau/bi sua. */
export function decodeConnectCode(code, password) {
  const raw = String(code || '').trim();
  if (!raw.startsWith(PREFIX)) throw new Error('Ma ket noi khong dung dinh dang (phai bat dau bang PE1.).');
  let packed;
  try {
    packed = JSON.parse(Buffer.from(raw.slice(PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw new Error('Ma ket noi bi hong — kiem tra lai khi copy/dan.');
  }
  const salt = Buffer.from(packed.salt, 'base64');
  const iv = Buffer.from(packed.iv, 'base64');
  const data = Buffer.from(packed.data, 'base64');
  const keyMat = derive(password, salt);
  const macKey = keyMat.subarray(32, 64);
  const expect = crypto.createHmac('sha256', macKey).update(Buffer.concat([salt, iv, data])).digest();
  const got = Buffer.from(packed.mac, 'base64');
  if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) {
    throw new Error('Sai mat khau (hoac ma da bi sua).');
  }
  const encKey = keyMat.subarray(0, 32);
  const decipher = crypto.createDecipheriv('aes-256-cbc', encKey, iv);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}
