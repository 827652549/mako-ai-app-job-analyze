/**
 * lagou-login.js
 *
 * 半自动登录脚本：连接到你的真实 Chrome 浏览器，打开拉勾网搜索页，
 * 手动完成滑块验证码后按回车，保存完整浏览器状态供 scrape.js 复用。
 *
 * 前置条件：先启动带远程调试的 Chrome（见下方提示）。
 *
 * 使用方式：
 *   1. 终端运行：open -a "Google Chrome" --args --remote-debugging-port=9222
 *   2. 再运行：node scripts/lagou-login.js
 */

'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const readline = require('readline');

const CDP_URL     = 'http://127.0.0.1:9222';
const STATE_FILE  = path.resolve(__dirname, '..', 'lagou-state.json');

async function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(prompt, () => { rl.close(); resolve(); }));
}

async function main() {
  console.log('连接真实 Chrome (CDP 9222)...');

  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch {
    console.error('\n❌ 无法连接 Chrome，请先在另一个终端运行：\n');
    console.error('   open -a "Google Chrome" --args --remote-debugging-port=9222\n');
    console.error('   如果 Chrome 已在运行，需要先退出再重新打开。\n');
    process.exit(1);
  }

  // 复用已有的 default context（就是你的真实 Chrome 窗口）
  const contexts = browser.contexts();
  const context = contexts[0] || await browser.newContext();

  const page = await context.newPage();
  await page.goto('https://www.lagou.com/wn/jobs?fromSearch=true&kd=%E5%89%8D%E7%AB%AF', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  await waitForEnter(
    '\n请在 Chrome 中完成滑块验证码（确保搜索结果页正常显示）' +
    '\n完成后回到此终端按【回车键】保存浏览器状态...\n'
  );

  // 保存完整状态：Cookie + localStorage + sessionStorage
  await context.storageState({ path: STATE_FILE });
  await page.close();

  // 断开 CDP 连接（不关闭真实 Chrome）
  browser.close();

  const size = (fs.statSync(STATE_FILE).size / 1024).toFixed(1);
  console.log(`\n✅ 浏览器状态已保存（${size} KB）→ ${STATE_FILE}`);
  console.log('   之后运行 npm run scrape 即可自动复用登录态。\n');
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
