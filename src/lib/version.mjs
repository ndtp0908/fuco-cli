// Phien ban pe — doc tu package.json khi chay bang node;
// ban dong goi SEA khong co package.json ben canh thi dung FALLBACK.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const FALLBACK_VERSION = '0.6.0';

export const VERSION = (() => {
  try {
    const p = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    return JSON.parse(readFileSync(p, 'utf8')).version || FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
})();

/** So sanh semver don gian: tra ve 1 neu a > b, -1 neu a < b, 0 neu bang. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}
