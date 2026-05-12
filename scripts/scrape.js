/**
 * scrape.js
 *
 * Use Playwright + system Chrome to scrape front-end job listings from 51job.
 * Strategy: navigate to the search page and intercept the API responses via
 * page.on('response') — this ensures real cookies and browser fingerprints.
 *
 * Usage: node scripts/scrape.js
 */

'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const KEYWORD = '前端';
const PAGES = 15;
const DELAY_MS = 2000;
const OUTPUT_DIR = path.resolve(__dirname, '..');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'raw_jobs.json'); // project root

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractFields(item) {
  return {
    jobName:             item.jobName        ?? item.job_name         ?? '',
    jobId:               item.jobid          ?? item.jobId            ?? '',
    companyName:         item.companyName    ?? item.company_name     ?? '',
    jobAreaString:       item.jobAreaString  ?? item.job_area_sub     ?? '',
    provideSalaryString: item.provideSalaryString ?? item.providesalary_text ?? '',
    workYearString:      item.workYearString ?? item.workyear         ?? '',
    degreeString:        item.degreeString   ?? item.degreefrom       ?? '',
    jobTags:             Array.isArray(item.jobTags)     ? item.jobTags
                       : Array.isArray(item.jobwelf_list) ? item.jobwelf_list
                       : [],
    jobDescribe:         item.jobDescribe    ?? (Array.isArray(item.attribute_text)
                           ? item.attribute_text.join(' ') : item.attribute_text) ?? '',
    updateDate:          item.updateDate     ?? item.issuedate        ?? '',
  };
}

async function main() {
  console.log('Launching browser...');

  let browser;
  try {
    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: false,   // 非 headless，更难被检测
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,800'],
    });
  } catch {
    browser = await chromium.launch({ channel: 'chrome', headless: false });
  }

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'zh-CN',
  });

  const allJobs = [];

  // 监听所有响应，抓取 51job 搜索 API 的 JSON
  const capturedResponses = [];

  context.on('response', async (response) => {
    const url = response.url();
    if (url.includes('we.51job.com/api/job/search-pc') || url.includes('search-pc')) {
      try {
        const json = await response.json();
        capturedResponses.push(json);
      } catch {
        // 忽略非 JSON 响应
      }
    }
  });

  const page = await context.newPage();

  // 直接访问搜索页，让浏览器自己发请求
  const searchUrl = `https://we.51job.com/pc/search?keyword=${encodeURIComponent(KEYWORD)}&searchType=2&sortType=0&metro=`;
  console.log(`打开搜索页: ${searchUrl}`);

  await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(3000);

  console.log(`第 1 页已加载，捕获到 ${capturedResponses.length} 个 API 响应`);

  // 处理第一页
  for (const json of capturedResponses.splice(0)) {
    const jobList = json?.engine_search_result?.job_list
                 ?? json?.resultbody?.job?.items
                 ?? [];
    const jobs = jobList.map(extractFields);
    allJobs.push(...jobs);
    if (jobs.length) console.log(`  第 1 页: ${jobs.length} 条岗位`);
  }

  // 翻页：点击"下一页"按钮
  for (let pageNo = 2; pageNo <= PAGES; pageNo++) {
    await sleep(DELAY_MS);

    // 尝试点击下一页按钮
    try {
      const nextBtn = page.locator('button.next-page, a.next-page, [class*="next"], span:has-text("下一页"), button:has-text("下一页")').first();
      const visible = await nextBtn.isVisible({ timeout: 5000 }).catch(() => false);
      if (!visible) {
        console.log(`第 ${pageNo} 页：找不到下一页按钮，停止翻页`);
        break;
      }
      await nextBtn.click();
      await page.waitForLoadState('networkidle', { timeout: 15000 });
      await sleep(2000);
    } catch (err) {
      console.error(`翻页到第 ${pageNo} 页失败:`, err.message);
      break;
    }

    console.log(`第 ${pageNo} 页已加载，捕获到 ${capturedResponses.length} 个新响应`);

    for (const json of capturedResponses.splice(0)) {
      const jobList = json?.engine_search_result?.job_list
                   ?? json?.resultbody?.job?.items
                   ?? [];
      const jobs = jobList.map(extractFields);
      allJobs.push(...jobs);
      if (jobs.length) console.log(`  第 ${pageNo} 页: ${jobs.length} 条岗位`);
    }

    if (allJobs.length === 0 && pageNo >= 2) {
      console.log('连续无数据，停止');
      break;
    }
  }

  await browser.close();

  // 写入文件
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allJobs, null, 2), 'utf-8');
  console.log(`\n完成！共抓取 ${allJobs.length} 条岗位`);
  console.log(`输出: ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
