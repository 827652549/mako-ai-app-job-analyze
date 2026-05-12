/**
 * lagou-login.js
 *
 * 半自动登录脚本：打开拉勾网搜索页，等待手动完成滑块验证码，
 * 确认页面正常加载后按回车，自动保存完整浏览器状态（Cookie + localStorage）
 * 到 lagou-state.json，后续爬虫自动复用。
 *
 * 使用方式：node scripts/lagou-login.js
 */

'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const readline = require('readline');

const CHROME_PATH  = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const STATE_FILE   = path.resolve(__dirname, '..', 'lagou-state.json');

async function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(prompt, () => { rl.close(); resolve(); }));
}

async function main() {
  console.log('启动 Chrome，打开拉勾网搜索页...\n');

  let browser;
  try {
    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: false,
      args: ['--window-size=1280,900'],
    });
  } catch {
    browser = await chromium.launch({ channel: 'chrome', headless: false });
  }

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
  });

  const page = await context.newPage();
  await page.goto('https://www.lagou.com/wn/jobs?fromSearch=true&kd=%E5%89%8D%E7%AB%AF', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  await waitForEnter(
    '\n请在浏览器中完成滑块验证码（确保搜索结果页正常显示）' +
    '\n完成后回到此终端按【回车键】保存浏览器状态...\n'
  );

  // 保存完整状态：Cookie + localStorage + sessionStorage
  await context.storageState({ path: STATE_FILE });
  await browser.close();

  const size = (fs.statSync(STATE_FILE).size / 1024).toFixed(1);
  console.log(`\n✅ 浏览器状态已保存（${size} KB）→ ${STATE_FILE}`);
  console.log('   之后运行 npm run scrape 即可自动复用登录态。\n');
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
