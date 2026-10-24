// Auto-compact ngu canh cho chat (giong dot 15 cua app):
// uoc tinh token ~ ky tu/4; khi lich su vuot 75% gioi han va con nhieu tin cu,
// goi model tom tat cac tin cu nhat thanh 1 muc, giu nguyen 12 tin gan nhat.
// Tom tat luu ngay trong phien (session.summary) nen mo lai van con.
import { chatCompletion } from './api.mjs';

export const KEEP_RECENT = 12;

export function estimateTokens(messages) {
  let chars = 0;
  for (const m of messages || []) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === 'text') chars += (part.text || '').length;
        else chars += 200; // anh/phan khac: uoc tinh co dinh
      }
    }
  }
  return Math.ceil(chars / 4);
}

const SUMMARY_SYSTEM = 'Bạn tóm tắt cuộc hội thoại coding thành văn bản ngắn gọn nhưng giữ đủ: mục tiêu, các quyết định, file đã sửa và nội dung sửa, lỗi đã gặp, việc còn dở dang. Chỉ trả về bản tóm tắt, không giải thích thêm.';

/**
 * Neu can thi rut gon: tra ve {messages, summary, compacted, dropped}.
 * Loi tom tat -> giu nguyen lich su (khong chan chat).
 */
export async function maybeCompact(cfg, { model, messages, summary, limit } = {}) {
  const lim = limit || cfg.contextLimit || 100000;
  const total = estimateTokens(messages) + (summary ? Math.ceil(summary.text.length / 4) : 0);
  if (total <= lim * 0.75 || messages.length <= KEEP_RECENT + 2) {
    return { messages, summary, compacted: false, dropped: 0 };
  }
  const keep = messages.slice(-KEEP_RECENT);
  const old = messages.slice(0, -KEEP_RECENT);
  const transcript = old
    .map((m) => `${m.role === 'user' ? 'NGƯỜI DÙNG' : 'PE'}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n')
    .slice(0, 60000);
  try {
    const { text } = await chatCompletion(cfg, {
      model,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        {
          role: 'user',
          content: (summary ? `Bản tóm tắt trước:\n${summary.text}\n\n` : '') + `Đoạn hội thoại cần tóm tắt${summary ? ' (gộp với bản trước)' : ''}:\n${transcript}`,
        },
      ],
    });
    return {
      messages: keep,
      summary: { text: text.trim(), count: (summary?.count || 0) + old.length },
      compacted: true,
      dropped: old.length,
    };
  } catch {
    return { messages, summary, compacted: false, dropped: 0 };
  }
}

/** Chen ban tom tat vao danh sach message gui cho model. */
export function withSummary(systemText, summary) {
  if (!summary?.text) return systemText;
  return `${systemText}\n\nTóm tắt phần hội thoại trước (${summary.count} tin):\n${summary.text}`;
}
