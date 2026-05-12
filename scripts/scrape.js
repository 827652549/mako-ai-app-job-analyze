/**
 * scrape.js
 *
 * Use Playwright + system Chrome to scrape front-end job listings from multiple platforms.
 * Currently supports: 前程无忧 (51job), 智联招聘 (Zhaopin).
 *
 * - 51job: intercept API responses via page.on('response')
 * - Zhaopin: SSR rendered, extract from window.__INITIAL_STATE__.positionList
 *
 * Usage: node scripts/scrape.js
 */

'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const KEYWORD = '前端';
const PAGES_51JOB = 15;
const PAGES_ZHAOPIN = 5;   // 智联默认 5 页，每页 20 条
const DELAY_MS = 2000;
const OUTPUT_DIR = path.resolve(__dirname, '..');

// Output file paths
const OUTPUT_51JOB    = path.join(OUTPUT_DIR, 'raw_jobs_51job.json');
const OUTPUT_ZHAOPIN  = path.join(OUTPUT_DIR, 'raw_jobs_zhaopin.json');
const OUTPUT_COMPAT   = path.join(OUTPUT_DIR, 'raw_jobs.json');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// 51job field extractor
// ---------------------------------------------------------------------------
function extractFields(item) {
  return {
    jobName:             item.jobName        ?? item.job_name         ?? '',
    jobId:               item.jobid          ?? item.jobId            ?? '',
    companyName:         item.companyName    ?? item.company_name     ?? '',
    jobAreaString:       item.jobAreaString  ?? item.job_area_sub     ?? '',
    provideSalaryString: item.provideSalaryString ?? item.providesalary_text ?? '',
    workYearString:      item.workYearString ?? item.workyear         ?? '',
    degreeString:        item.degreeString   ?? item.degreefrom       ?? '',
    jobTags:             Array.isArray(item.jobTags)      ? item.jobTags
                       : Array.isArray(item.jobwelf_list) ? item.jobwelf_list
                       : [],
    jobDescribe:         item.jobDescribe    ?? (Array.isArray(item.attribute_text)
                           ? item.attribute_text.join(' ') : item.attribute_text) ?? '',
    updateDate:          item.updateDate     ?? item.issuedate        ?? '',
  };
}

// ---------------------------------------------------------------------------
// 智联招聘 field extractor
// ---------------------------------------------------------------------------
function extractZhaopinFields(item) {
  // skillLabel 是 [{state, value}] 对象数组，提取 value 字符串
  const rawTags = Array.isArray(item.skillLabel) ? item.skillLabel
                : Array.isArray(item.jobSkillTags) ? item.jobSkillTags
                : [];
  const tags = rawTags.map(t => (typeof t === 'string' ? t : t?.value || '')).filter(Boolean);

  return {
    jobName:             item.name || item.positionName || '',
    jobId:               String(item.jobId || item.number || ''),
    companyName:         item.companyName || '',
    jobAreaString:       item.workCity || item.cityDistrict || '',
    provideSalaryString: item.salary60 || item.salaryReal || '',
    workYearString:      item.workingExp || '',
    degreeString:        item.education || '',
    jobTags:             tags,
    jobDescribe:         item.jobSummary || '',
    updateDate:          item.publishTime || '',
  };
}

// ---------------------------------------------------------------------------
// 前程无忧爬虫
// ---------------------------------------------------------------------------
async function scrape51job(context, pages) {
  console.log('\n[前程无忧] 开始采集...');
  const allJobs = [];
  const capturedResponses = [];

  const onResponse = async (response) => {
    const url = response.url();
    if (url.includes('we.51job.com/api/job/search-pc') || url.includes('search-pc')) {
      try {
        const json = await response.json();
        capturedResponses.push(json);
      } catch {
        // ignore non-JSON
      }
    }
  };
  context.on('response', onResponse);

  const page = await context.newPage();
  const searchUrl = `https://we.51job.com/pc/search?keyword=${encodeURIComponent(KEYWORD)}&searchType=2&sortType=0&metro=`;
  console.log(`[前程无忧] 打开搜索页: ${searchUrl}`);

  try {
    await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 60000 });
    await sleep(3000);

    console.log(`[前程无忧] 第 1 页已加载，捕获到 ${capturedResponses.length} 个 API 响应`);

    for (const json of capturedResponses.splice(0)) {
      const jobList = json?.engine_search_result?.job_list
                   ?? json?.resultbody?.job?.items ?? [];
      const jobs = jobList.map(extractFields);
      allJobs.push(...jobs);
      if (jobs.length) console.log(`  [前程无忧] 第 1 页: ${jobs.length} 条岗位`);
    }

    for (let pageNo = 2; pageNo <= pages; pageNo++) {
      await sleep(DELAY_MS);
      try {
        const nextBtn = page.locator('button.next-page, a.next-page, [class*="next"], span:has-text("下一页"), button:has-text("下一页")').first();
        const visible = await nextBtn.isVisible({ timeout: 5000 }).catch(() => false);
        if (!visible) {
          console.log(`[前程无忧] 第 ${pageNo} 页：找不到下一页按钮，停止翻页`);
          break;
        }
        await nextBtn.click();
        await page.waitForLoadState('networkidle', { timeout: 15000 });
        await sleep(2000);
      } catch (err) {
        console.error(`[前程无忧] 翻页到第 ${pageNo} 页失败:`, err.message);
        break;
      }

      console.log(`[前程无忧] 第 ${pageNo} 页已加载，捕获到 ${capturedResponses.length} 个新响应`);

      for (const json of capturedResponses.splice(0)) {
        const jobList = json?.engine_search_result?.job_list
                     ?? json?.resultbody?.job?.items ?? [];
        const jobs = jobList.map(extractFields);
        allJobs.push(...jobs);
        if (jobs.length) console.log(`  [前程无忧] 第 ${pageNo} 页: ${jobs.length} 条岗位`);
      }

      if (allJobs.length === 0 && pageNo >= 2) {
        console.log('[前程无忧] 连续无数据，停止');
        break;
      }
    }
  } finally {
    await page.close();
    context.off('response', onResponse);
  }

  console.log(`[前程无忧] 采集完成，共 ${allJobs.length} 条`);
  return { jobs: allJobs, platform: '前程无忧' };
}

// ---------------------------------------------------------------------------
// 智联招聘爬虫（SSR 直出，从 __INITIAL_STATE__ 提取）
// ---------------------------------------------------------------------------
async function scrapeZhaopin(context, pages) {
  console.log('\n[智联招聘] 开始采集...');
  const allJobs = [];
  const cityCode = '530'; // 北京

  for (let pageNo = 1; pageNo <= pages; pageNo++) {
    const searchUrl = `https://sou.zhaopin.com/?jl=${cityCode}&kw=${encodeURIComponent(KEYWORD)}&p=${pageNo}`;
    console.log(`[智联招聘] 打开第 ${pageNo} 页: ${searchUrl}`);

    const page = await context.newPage();
    try {
      await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 60000 });
      await sleep(2000);

      const { jobs, total, totalPages } = await page.evaluate(() => {
        const state = window.__INITIAL_STATE__;
        if (!state || !Array.isArray(state.positionList)) {
          return { jobs: [], total: 0, totalPages: 0 };
        }
        return {
          jobs: state.positionList,
          total: state.positionCount || 0,
          totalPages: state.pages || 0,
        };
      });

      const extracted = jobs.map(extractZhaopinFields);
      allJobs.push(...extracted);
      console.log(`  [智联招聘] 第 ${pageNo} 页: ${extracted.length} 条岗位 (总 ${total}, ${totalPages} 页)`);

      if (pageNo >= totalPages) {
        console.log('[智联招聘] 已到最后一页');
        break;
      }
    } catch (err) {
      console.error(`[智联招聘] 第 ${pageNo} 页失败:`, err.message);
    } finally {
      await page.close();
    }

    if (pageNo < pages) await sleep(DELAY_MS);
  }

  console.log(`[智联招聘] 采集完成，共 ${allJobs.length} 条`);
  return { jobs: allJobs, platform: '智联招聘' };
}

// ---------------------------------------------------------------------------
// 写入 JSON 文件
// ---------------------------------------------------------------------------
function writeJson(filePath, data) {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`输出: ${filePath} (${data.length} 条)`);
}

// ---------------------------------------------------------------------------
// 主函数
// ---------------------------------------------------------------------------
async function main() {
  console.log('Launching browser...');

  let browser;
  try {
    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,800'],
    });
  } catch {
    browser = await chromium.launch({ channel: 'chrome', headless: false });
  }

  const contextOptions = {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'zh-CN',
  };

  // --- 前程无忧 ---
  const ctx51 = await browser.newContext(contextOptions);
  let jobs51job = [];
  try {
    const result = await scrape51job(ctx51, PAGES_51JOB);
    jobs51job = result.jobs;
  } catch (err) {
    console.warn('[前程无忧] 采集失败，跳过:', err.message);
  }
  await ctx51.close();

  // --- 智联招聘 ---
  const ctxZhaopin = await browser.newContext(contextOptions);
  let jobsZhaopin = [];
  try {
    const result = await scrapeZhaopin(ctxZhaopin, PAGES_ZHAOPIN);
    jobsZhaopin = result.jobs;
  } catch (err) {
    console.warn('[智联招聘] 采集失败，跳过:', err.message);
  }
  await ctxZhaopin.close();

  await browser.close();

  // --- 写入文件 ---
  console.log('\n写入输出文件...');
  writeJson(OUTPUT_51JOB,    jobs51job);
  writeJson(OUTPUT_ZHAOPIN,  jobsZhaopin);
  writeJson(OUTPUT_COMPAT,   jobs51job);

  console.log(`\n完成！`);
  console.log(`  前程无忧: ${jobs51job.length} 条`);
  console.log(`  智联招聘: ${jobsZhaopin.length} 条`);
  console.log(`  合计:     ${jobs51job.length + jobsZhaopin.length} 条`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
