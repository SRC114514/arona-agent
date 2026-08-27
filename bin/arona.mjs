#!/usr/bin/env node
// ARONA CLI entry point. Node 22's --experimental-strip-types refuses to load
// .ts files inside node_modules/, so we use `tsx` (shipped as a regular dep) as
// a child-process runner. `tsx` is a self-contained .ts loader that handles
// ESM, CJS, and node_modules code paths.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const args = process.argv.slice(2);

const isSetup = args[0] === 'setup';
const isVoice = args[0] === 'voice';
const isDoctor = args[0] === 'doctor';
const target = isSetup ? 'src/setup.ts' : isVoice ? 'src/voice_cli.ts' : isDoctor ? 'src/doctor.ts' : 'src/index.ts';
const passArgs = (isSetup || isVoice || isDoctor) ? args.slice(1) : args;

// tsx ships a CLI binary alongside the package. We prefer the local install.
const tsxBin = process.platform === 'win32'
  ? join(root, 'node_modules', '.bin', 'tsx.cmd')
  : join(root, 'node_modules', '.bin', 'tsx');

if (!existsSync(tsxBin)) {
  // 此文件无法 import TS，内联判定语言（仅环境变量）
  const isEn = /^en/i.test(process.env.LANG ?? "");
  console.error(
    isEn
      ? `Error: tsx not found at ${tsxBin}.\nRun \`npm install\` in ${root} (or run \`arona setup\` to install dependencies).`
      : `错误：未找到 tsx（${tsxBin}）。\n请在 ${root} 运行 \`npm install\`（或运行 \`arona setup\` 安装依赖）。`,
  );
  process.exit(1);
}

const child = spawn(tsxBin, [join(root, target), ...passArgs], {
  // 保持用户调用 arona 时所在的目录作为工作目录（Workspace = CWD）。
  // 之前固定 cwd: root 会让全局安装的 arona 把包目录当工作区，文件工具/项目文档/undo 全部错位。
  cwd: process.cwd(),
  stdio: 'inherit',
  // Windows: tsxBin 是 .cmd 批处理文件。Node >=20.12.2/18.20.2（CVE-2024-27980 修复）
  // 起，spawn .bat/.cmd 且不设 shell 会直接抛 EINVAL，导致 `arona setup` 在 Windows 上无法启动。
  shell: process.platform === 'win32',
});
child.on('exit', (code) => process.exit(code ?? 0));
