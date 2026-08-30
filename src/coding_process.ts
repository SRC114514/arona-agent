// 编码子代理过程留痕的桥接：create_subagent 工具产出执行快照，GUI 控制器经 sink 落盘。
// CLI 不设 sink → 记录直接丢弃，保持 CLI 现有行为（终端流式输出，不落盘）。
// 另有事件转发通道：GUI 下子代理 session 事件实时推给前端渲染；CLI 无订阅方，零开销。
import type { CodingRun } from "./memory.ts";

type CodingRunSink = (run: CodingRun) => void;
type CodingEventSink = (agentId: string, event: unknown) => void;

let sink: CodingRunSink | null = null;
let eventSink: CodingEventSink | null = null;

export function setCodingRunSink(fn: CodingRunSink | null): void {
  sink = fn;
}

export function setCodingEventSink(fn: CodingEventSink | null): void {
  eventSink = fn;
}

export function recordCodingRun(run: CodingRun): void {
  if (!sink) return;
  try {
    sink(run);
  } catch (err) {
    console.warn(`recordCodingRun: ${err instanceof Error ? err.message : err}`);
  }
}

export function emitCodingEvent(agentId: string, event: unknown): void {
  if (!eventSink) return;
  try {
    eventSink(agentId, event);
  } catch {
    // 转发失败不影响子代理执行
  }
}
