#!/usr/bin/env node
// ARONA CLI entry point. Node 22's --experimental-strip-types refuses to load
// .ts files inside node_modules/, so we use `tsx` (shipped as a regular dep) as
// a child-process runner. `tsx` is a self-contained .ts loader that handles
// ESM, CJS, and node_modules code paths.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, delimiter } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const args = process.argv.slice(2);

// 自包含运行时（npm run package 产物 runtime/）：存在则前置 PATH，
// 让 tsx 的 `#!/usr/bin/env node` 及一切后续子进程都解析到包内 Node/Python，
// 即使不经 arona.sh 直接用系统 node 启动本文件也一样自包含。
const runtimePathEntries = process.platform === 'win32'
  ? [join(root, 'runtime', 'node'), join(root, 'runtime', 'python')]
  : [join(root, 'runtime', 'node', 'bin'), join(root, 'runtime', 'python', 'bin')];
const bundledEntries = runtimePathEntries.filter((p) => existsSync(p));
if (bundledEntries.length) {
  process.env.PATH = [...bundledEntries, process.env.PATH].join(delimiter);
}

const isSetup = args[0] === 'setup';
const isVoice = args[0] === 'voice';
const isDoctor = args[0] === 'doctor';
// 裸 `arona` 默认进 GUI：src/index.ts 依据 --cli / settings.json CLIEnabled 自行分流
const target = isSetup ? 'src/setup.ts' : isVoice ? 'src/voice_cli.ts' : isDoctor ? 'src/doctor.ts' : 'src/index.ts';
const passArgs = (isSetup || isVoice || isDoctor) ? args.slice(1) : args;

// tsx 以库形式随包内置：直接用当前 node 运行其 CLI，避免依赖 node_modules/.bin
// （Windows 包里没有 .cmd shim，且跨平台无需 PATH 里能找到 node）。
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');

if (!existsSync(tsxCli)) {
  // 此文件无法 import TS，内联判定语言（仅环境变量）
  const isEn = /^en/i.test(process.env.LANG ?? "");
  console.error(
    isEn
      ? `Error: tsx not found at ${tsxCli}.\nRun \`npm install\` in ${root} (or run \`arona setup\` to install dependencies).`
      : `错误：未找到 tsx（${tsxCli}）。\n请在 ${root} 运行 \`npm install\`（或运行 \`arona setup\` 安装依赖）。`,
  );
  process.exit(1);
}

const child = spawn(process.execPath, [tsxCli, join(root, target), ...passArgs], {
  // 保持用户调用 arona 时所在的目录作为工作目录（Workspace = CWD）。
  // 之前固定 cwd: root 会让全局安装的 arona 把包目录当工作区，文件工具/项目文档/undo 全部错位。
  cwd: process.cwd(),
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 0));
