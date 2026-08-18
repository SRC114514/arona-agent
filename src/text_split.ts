/**
 * 流式文本切句工具：renderer 气泡与 TTS 共用同一套算法。
 *
 * 规则：
 * - 优先在中文/英文句末标点（。！？!?\n）处切句，连续标点归入同一条。
 * - 连续无标点超过 forceLen 字时，按 forceLen 强切，避免长文本滞留。
 * - 返回本次可输出的完整句子和剩余残段（等待后续 delta 或 isEnd 收尾）。
 */
const SENTENCE_BOUNDARY = /[。！？!?\n]/;

/** CJK 表意文字（含扩展 A 区与兼容区）：字数统计中每个字符算 1 字。 */
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g;

export interface SplitStreamedTextResult {
  sentences: string[];
  rest: string;
}

/**
 * 统计"朗读/气泡字数"：中文字符每个算 1，英文/数字按空白切分的连续串每个算 1
 * （一个英文单词算一个字），中英文标点与符号不计入。
 */
export function countTextUnits(text: string): number {
  // 去掉所有标点符号（仅保留字母、数字、空白与 CJK）
  const noPunct = text.replace(/[^\p{L}\p{N}\s]/gu, "");
  const cjkCount = (noPunct.match(CJK_RE) || []).length;
  const latinPart = noPunct.replace(CJK_RE, " ");
  const words = latinPart.trim().split(/\s+/).filter(Boolean).length;
  return cjkCount + words;
}

export function splitStreamedText(buffer: string, forceLen: number): SplitStreamedTextResult {
  const sentences: string[] = [];
  let current = "";

  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i];
    current += ch;

    if (SENTENCE_BOUNDARY.test(ch)) {
      // 连续标点（如“！！”）与当前句一起输出，避免产生只有标点的碎句
      while (i + 1 < buffer.length && SENTENCE_BOUNDARY.test(buffer[i + 1])) {
        current += buffer[i + 1];
        i++;
      }
      const sent = current.trim();
      if (sent) sentences.push(sent);
      current = "";
    } else if (current.length >= forceLen) {
      const sent = current.trim();
      if (sent) sentences.push(sent);
      current = "";
    }
  }

  return { sentences, rest: current };
}
