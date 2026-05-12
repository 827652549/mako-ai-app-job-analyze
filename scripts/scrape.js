/**
 * scrape.js
 *
 * Use Playwright + system Chrome (headless) to scrape front-end job listings
 * from 51job (前程无忧) and write results to data/raw_jobs.json.
 *
 * Usage: node scripts/scrape.js
 */

'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const KEYWORD = '前端';
const PAGES = 5;
const DELAY_MS = 800;
const BASE_URL = 'https://we.51job.com/api/job/search-pc';
const HOME_URL = 'https://www.51job.com';
const OUTPUT_DIR = path.resolve(__dirname, '../data');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'raw_jobs.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sleep for `ms` milliseconds. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Generate a UUID v4 string. Works on Node 14.17+. */
function generateUUID() {
  try {
    return require('crypto').randomUUID();
  } catch {
    // Fallback for older Node versions
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}

/**
 * Build the search API URL for a given page number.
 * @param {string} cookie - Cookie string obtained from browser session
 * @param {number} pageNo  - 1-based page number
 * @returns {string}
 */
function buildApiUrl(pageNo) {
  const timestamp = Date.now();
  const requestId = generateUUID();
  const params = new URLSearchParams({
    api_key: '51job',
    timestamp: String(timestamp),
    keyword: KEYWORD,
    searchType: '2',
    jobArea: '000000',
    pageNo: String(pageNo),
    pageSize: '50',
    requestId,
    lang: 'c',
    stype: '1',
    postchannel: '0000',
    workyear: '99',
    cotype: '99',
    degreefrom: '99',
    jobterm: '99',
    companysize: '99',
    ord_field: '0',
    dibiaoid: '0',
    line: '',
    welfare: '',
  });
  return `${BASE_URL}?${params.toString()}`;
}

/**
 * Extract the relevant fields from a raw job item returned by the API.
 * The raw structure is preserved; only the documented fields are selected.
 * @param {object} item
 * @returns {object}
 */
function extractFields(item) {
  return {
    jobName: item.jobName ?? item.job_name ?? '',
    jobId: item.jobid ?? item.jobId ?? '',
    companyName: item.companyName ?? item.company_name ?? '',
    companyId: item.companyId ?? item.companyid ?? '',
    jobAreaString: item.jobAreaString ?? item.job_area_sub ?? '',
    provideSalaryString: item.provideSalaryString ?? item.providesalary_text ?? '',
    workYearString: item.workYearString ?? item.workyear ?? '',
    degreeString: item.degreeString ?? item.degreefrom ?? '',
    jobTags: item.jobTags ?? item.jobwelf_list ?? [],
    jobDescribe: item.jobDescribe ?? item.attribute_text ?? '',
    updateDate: item.updateDate ?? item.issuedate ?? '',
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Launching browser...');

  let browser;
  try {
    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  } catch (err) {
    console.error('Failed to launch Chrome at executablePath, falling back to channel:chrome');
    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  // Step 1: Visit homepage to initialise cookies
  console.log(`Visiting homepage to initialise cookies: ${HOME_URL}`);
  try {
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);
    console.log('Homepage loaded, cookies initialised.');
  } catch (err) {
    console.error('Warning: failed to load homepage:', err.message);
    // Continue anyway; we may still have enough context.
  }

  // Step 2: Retrieve cookies and User-Agent for subsequent API calls
  const cookies = await context.cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

  // Step 3: Iterate pages and call the search API
  const allJobs = [];

  for (let pageNo = 1; pageNo <= PAGES; pageNo++) {
    const url = buildApiUrl(pageNo);
    console.log(`Fetching page ${pageNo}/${PAGES}...`);

    let jobList = [];

    try {
      // Use page.evaluate to fire a fetch from inside the browser context so
      // that cookies and browser fingerprints are automatically included.
      const responseText = await page.evaluate(
        async ({ fetchUrl, cookieStr }) => {
          const res = await fetch(fetchUrl, {
            method: 'GET',
            headers: {
              Accept: 'application/json, text/plain, */*',
              'Accept-Language': 'zh-CN,zh;q=0.9',
              Cookie: cookieStr,
              Referer: 'https://we.51job.com/',
            },
            credentials: 'include',
          });
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }
          return res.text();
        },
        { fetchUrl: url, cookieStr: cookieHeader }
      );

      const json = JSON.parse(responseText);

      // Normalise response shape — the API has been observed to return either:
      //   { engine_search_result: { job_list: [...] } }
      // or (older endpoint):
      //   { resultbody: { job: { items: [...] } } }
      if (json?.engine_search_result?.job_list) {
        jobList = json.engine_search_result.job_list;
      } else if (json?.resultbody?.job?.items) {
        jobList = json.resultbody.job.items;
      } else {
        console.warn(`Page ${pageNo}: unexpected response shape, skipping.`);
      }
    } catch (err) {
      console.error(`Page ${pageNo}: network/parse error — ${err.message}`);
      // Continue to next page instead of aborting.
    }

    if (jobList.length === 0) {
      console.log(`Page ${pageNo}: empty job list, stopping early.`);
      break;
    }

    const extracted = jobList.map(extractFields);
    allJobs.push(...extracted);
    console.log(`Page ${pageNo}: got ${extracted.length} jobs (total so far: ${allJobs.length})`);

    if (pageNo < PAGES) {
      await sleep(DELAY_MS);
    }
  }

  // Step 4: Write results to disk
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allJobs, null, 2), 'utf-8');
  console.log(`\nDone! Scraped ${allJobs.length} jobs in total.`);
  console.log(`Output written to: ${OUTPUT_FILE}`);

  await browser.close();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
