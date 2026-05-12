/**
 * lagou-login.js
 *
 * 一次性登录脚本：打开拉勾网，手动完成登录 / 滑块验证码后，
 * 按回车键，自动将 Cookie 保存到 lagou-cookies.json。
 *
 * 使用方式：node scripts/lagou-login.js
 */

'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const readline = require('readline');

const CHROME_PATH  = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const COOKIES_FILE = path.resolve(__dirname, '..', 'lagou-cookies.json');

async function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(prompt, () => { rl.close(); resolve(); }));
}

async function main() {
  console.log('启动 Chrome，请在浏览器中完成登录或滑块验证码...\n');

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

  await waitForEnter('\n✅ 请在浏览器中完成登录或验证码，完成后回到此终端按【回车键】保存 Cookie...\n');

  const cookies = await context.cookies('https://www.lagou.com');
  await browser.close();

  fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2), 'utf-8');
  console.log(`\n✅ Cookie 已保存（${cookies.length} 条）→ ${COOKIES_FILE}`);
  console.log('   之后运行 npm run scrape 即可自动复用登录态。\n');
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
