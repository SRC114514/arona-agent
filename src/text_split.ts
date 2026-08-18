/**
 * 流式文本切句工具：renderer 气泡与 TTS 共用同一套算法。
 *
 * 规则：
 * - 只在句子终止标点（中文。！？… / 英文 . ! ? / 换行）处切句，连续终止标点归入同一条。
 * - 英文句点 "." 仅当后跟空白/换行/中文/中文标点/串尾时才视为句末，
 *   避免把小数点/版本号（"3.12"、"qwen-audio-3.0"）误切。
 * - 逗号族（，、；：,;:）不做句边界，保留在句内交给 TTS 引擎自行处理停顿，
 *   避免把"好好吃饭哦，Sensei"拆成碎句破坏语气。
 * - 连续无标点超过 forceLen 字时，按 forceLen 强切，避免长文本滞留。
 * - 返回本次可输出的完整句子和剩余残段（等待后续 delta 或 isEnd 收尾）。
 */
const SENTENCE_END = /[。！？!?\n…]/;

/** 判断 buffer[i]（英文句点）是否为句末：后跟空白/换行/中文/中文标点/串尾才算，否则视为小数点或缩写。 */
function isPeriodEnd(buffer: string, i: number): boolean {
  if (buffer[i] !== ".") return false;
  const next = buffer[i + 1];
  if (next === undefined) return true;
  if (/\s/.test(next)) return true;
  if (/[。！？!?…，、；：]/.test(next)) return true;
  if (/[\u4e00-\u9fff]/.test(next)) return true;
  return false;
}

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

    const isEnd = SENTENCE_END.test(ch) || isPeriodEnd(buffer, i);

    if (isEnd) {
      // 连续终止标点（如“！！”、“…”、句点+空格）与当前句一起输出，避免产生只有标点的碎句
      while (i + 1 < buffer.length) {
        const nx = buffer[i + 1];
        if (SENTENCE_END.test(nx) || nx === "." || nx === " ") {
          current += nx;
          i++;
        } else {
          break;
        }
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
