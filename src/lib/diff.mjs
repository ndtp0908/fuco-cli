// Diff dong don gian (LCS) de xem truoc khi sua file.
// File qua lon thi chi bao tom tat, tranh cham.

/** Tra ve mang {type: ' '|'-'|'+', text} + thong ke. */
export function diffLines(oldText, newText) {
  const a = String(oldText).split('\n');
  const b = String(newText).split('\n');
  if (a.length > 1500 || b.length > 1500) {
    return { ops: null, added: null, removed: null, tooBig: true, oldLines: a.length, newLines: b.length };
  }
  // LCS bang quy hoach dong theo hang (tiet kiem bo nho)
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { ops.push({ type: ' ', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: '-', text: a[i] }); i++; removed++; }
    else { ops.push({ type: '+', text: b[j] }); j++; added++; }
  }
  while (i < m) { ops.push({ type: '-', text: a[i] }); i++; removed++; }
  while (j < n) { ops.push({ type: '+', text: b[j] }); j++; added++; }
  return { ops, added, removed, tooBig: false };
}

/**
 * Dinh dang diff de in: chi hien cac doan co thay doi + 2 dong ngu canh,
 * gioi han maxShow dong thay doi.
 */
export function formatDiff(oldText, newText, { maxShow = 120 } = {}) {
  const d = diffLines(oldText, newText);
  if (d.added === 0 && d.removed === 0 && !d.tooBig) return '(khong thay doi)';
  if (d.tooBig) return `File lon: ${d.oldLines} dong -> ${d.newLines} dong (bo qua hien diff chi tiet).`;
  const keep = new Array(d.ops.length).fill(false);
  d.ops.forEach((op, idx) => {
    if (op.type !== ' ') {
      for (let k = Math.max(0, idx - 2); k <= Math.min(d.ops.length - 1, idx + 2); k++) keep[k] = true;
    }
  });
  const lines = [];
  let shownChanges = 0;
  let skipping = false;
  d.ops.forEach((op, idx) => {
    if (!keep[idx]) {
      if (!skipping) { lines.push('  ...'); skipping = true; }
      return;
    }
    skipping = false;
    if (op.type !== ' ') {
      shownChanges++;
      if (shownChanges > maxShow) return;
    }
    lines.push(`${op.type} ${op.text}`);
  });
  if (shownChanges > maxShow) lines.push(`  ... (con ${shownChanges - maxShow} dong thay doi nua)`);
  lines.push(`Tong: +${d.added} dong, -${d.removed} dong`);
  return lines.join('\n');
}
