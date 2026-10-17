#!/usr/bin/env node
/**
 * Model Doctor —— 便携式模型能力测试器
 *
 * 用法:
 *   node bin/model-doctor.mjs                 # 启动并自动打开浏览器
 *   node bin/model-doctor.mjs --no-open       # 只启动服务
 *   node bin/model-doctor.mjs --port 7788     # 指定端口
 *
 * 也可直接 CLI 模式（无界面）:
 *   node bin/model-doctor.mjs --base https://api.openai.com/v1 --key sk-xxx --model gpt-4o-mini
 */
import { startServer } from '../src/server.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* 打不开浏览器时仍打印 URL */
  }
}

const args = parseArgs(process.argv);

if (args.help || args.h) {
  console.log(`
Model Doctor —— 便携式模型能力测试器

  node bin/model-doctor.mjs [选项]

选项:
  --port <n>        监听端口（默认随机可用端口）
  --host <addr>     监听地址（默认 127.0.0.1）
  --no-open         不自动打开浏览器
  --base <url>      CLI 模式下直接测试：上游 baseURL
  --key <key>       CLI 模式下直接测试：API Key
  --model <name>    CLI 模式下直接测试：模型名
  --tests <a,b>     只跑指定测试项
  --json            以 JSON 输出报告
  --help            显示帮助
`);
  process.exit(0);
}

/* ---------------- CLI 直跑模式 ---------------- */
if (args.base && args.model) {
  const { createRun, executeRun } = await import('../src/core/runner.mjs');
  const tests = args.tests ? String(args.tests).split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const run = createRun({
    baseUrl: args.base,
    apiKey: args.key || '',
    model: args.model,
    tests,
    concurrency: Number(args.concurrency) || 3,
  });
  if (!args.json) {
    console.log(`\n▶ 测试模型 ${run.model} @ ${run.baseUrl}\n`);
  }
  const report = await executeRun(run);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const it of report.items) {
      const icon = it.status === 'pass' ? '✔' : it.status === 'fail' ? '✘' : '–';
      console.log(`${icon} ${it.label.padEnd(24, ' ')} ${it.result?.detail || it.error || ''}`);
    }
    console.log(
      `\n结论: ${report.verdict.label}  得分 ${report.summary.score}  (${report.summary.passed}/${report.summary.total})` +
        (report.summary.latencyP50Ms ? `  P50 ${report.summary.latencyP50Ms}ms` : '')
    );
    console.log(`耗时: ${(report.durationMs / 1000).toFixed(1)}s\n`);
  }
  process.exit(report.verdict.tier === 'unreachable' ? 2 : 0);
}

/* ---------------- 服务模式 ---------------- */
const { url } = await startServer({
  port: Number(args.port) || 0,
  host: args.host || '127.0.0.1',
});

const banner = `
  ███╗   ███╗ ██████╗ ██████╗ ███████╗██╗
  ████╗ ████║██╔═══██╗██╔══██╗██╔════╝██║
  ██╔████╔██║██║   ██║██║  ██║█████╗  ██║
  ██║╚██╔╝██║██║   ██║██║  ██║██╔══╝  ██║
  ██║ ╚═╝ ██║╚██████╔╝██████╔╝███████╗███████╗
  ╚═╝     ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝╚══════╝
                  D O C T O R   v1.0.0

  ▶ 服务地址: ${url}
  ▶ 端口: ${url.split(':').pop()}
  ▶ 仅监听本机，密钥不出本机
  ▶ 按 Ctrl+C 停止
`;
console.log(banner);

if (!args['no-open']) openBrowser(url);
