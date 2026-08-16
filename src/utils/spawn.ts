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

/**
 * 剔除代理环境变量，返回新对象（不改动原 process.env）。
 *
 * Python 侧 websockets/requests 会读 ALL_PROXY/all_proxy 走 SOCKS 代理；用户本机常开 Clash
 * 为 GitHub 等设 SOCKS 代理，但阿里云百炼 DashScope 是国内服务、应直连。若代理变量泄漏进
 * Python 子进程，websockets 16.x 会报 "connecting through a SOCKS proxy requires python-socks"。
 * 故所有 spawn Python 语音脚本（TTS/STT）时都用此函数清洗 env。
 */
export function stripProxyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of [
    "ALL_PROXY", "all_proxy",
    "SOCKS_PROXY", "socks_proxy",
    "HTTP_PROXY", "http_proxy",
    "HTTPS_PROXY", "https_proxy",
  ]) {
    delete out[key];
  }
  return out;
}
