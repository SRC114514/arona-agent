import { spawn, type SpawnOptions, type ChildProcessWithoutNullStreams } from "child_process";

/**
 * 跨平台 spawn 封装。
 *
 * Node >= 20.12.2 / 18.20.2 / 21.7.3（2024-04-10 起，CVE-2024-27980 安全修复）引入破坏性变更：
 * Windows 上 spawn() 直接执行 .bat / .cmd 文件、且未设置 `shell: true` 时会直接抛 EINVAL。
 * 这里检测命令是否为批处理文件，命中时自动补 shell，保证 Windows 端不炸、其他平台零影响。
 *
 * 注意：shell 仅在 .bat/.cmd 场景启用，避免对普通 exe 命令引入 shell 解析副作用。
 * 调用方传入的参数均为内部固定值，无外部不可信输入，注入风险可控。
 */
function isBatchFile(command: string): boolean {
  // 取命令第一个 token（兼容带引号的完整路径）
  const trimmed = command.trim();
  let first: string;
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    first = end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
  } else {
    first = trimmed.split(/\s+/)[0];
  }
  return /\.(bat|cmd)$/i.test(first);
}

export function spawnCompat(
  command: string,
  args: string[] = [],
  options: SpawnOptions = {},
): ChildProcessWithoutNullStreams {
  if (process.platform === "win32" && isBatchFile(command)) {
    return spawn(command, args, { ...options, shell: true }) as ChildProcessWithoutNullStreams;
  }
  return spawn(command, args, options) as ChildProcessWithoutNullStreams;
}
