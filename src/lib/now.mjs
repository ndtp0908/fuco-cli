// Dong thoi gian hien tai chen vao system prompt. Model free khong biet
// "hom nay" la ngay nao — khong chen dong nay thi model bia ngay theo du
// lieu huan luyen cu (da tung tra loi nham sang nam 2024).
export function currentTimeLine(now = new Date()) {
  const s = now.toLocaleString('vi-VN', {
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `Thoi gian hien tai (may nguoi dung): ${s}. Khi nguoi dung noi "hom nay", "bay gio", "tuan nay" thi tinh theo thoi gian nay — dung tu bia ngay/gio khac.`;
}
