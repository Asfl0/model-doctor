/**
 * 无头截图：验证模型搜索器 UI（需要本机 Chrome/Edge）
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const exe = CANDIDATES.find((p) => existsSync(p));
if (!exe) {
  console.log('NO_BROWSER');
  process.exit(0);
}

const url = process.argv[2] || 'http://127.0.0.1:7792/';
const out = process.argv[3] || resolve('shot-ui.png');
mkdirSync(resolve(out, '..'), { recursive: true });

const child = spawn(exe, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--window-size=1440,1000',
  `--screenshot=${out}`,
  '--virtual-time-budget=4000',
  url,
], { stdio: 'ignore' });

child.on('exit', (code) => {
  console.log(`browser exit ${code} -> ${out}`);
  process.exit(0);
});
