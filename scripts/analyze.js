'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Skill dictionary — 23 entries
// ---------------------------------------------------------------------------
const SKILLS = [
  { name: 'Vue',           keywords: ['vue'] },
  { name: 'React',         keywords: ['react'] },
  { name: 'Angular',       keywords: ['angular'] },
  { name: 'TypeScript',    keywords: ['typescript', 'ts '] },
  { name: 'JavaScript',    keywords: ['javascript', 'js '] },
  { name: 'Node.js',       keywords: ['node.js', 'nodejs', 'node '] },
  { name: 'Webpack',       keywords: ['webpack'] },
  { name: 'Vite',          keywords: ['vite'] },
  { name: 'React Native',  keywords: ['react native', 'react-native'] },
  { name: 'Flutter',       keywords: ['flutter'] },
  { name: 'uni-app',       keywords: ['uni-app', 'uniapp'] },
  { name: '小程序',         keywords: ['小程序', 'miniprogram'] },
  { name: '微前端',         keywords: ['微前端', 'micro-frontend'] },
  { name: 'Next.js',       keywords: ['next.js', 'nextjs'] },
  { name: 'Nuxt',          keywords: ['nuxt'] },
  { name: 'Redux',         keywords: ['redux'] },
  { name: 'Pinia',         keywords: ['pinia'] },
  { name: 'Vuex',          keywords: ['vuex'] },
  { name: 'MobX',          keywords: ['mobx'] },
  { name: 'Tailwind',      keywords: ['tailwind'] },
  { name: 'ECharts',       keywords: ['echarts'] },
  { name: 'Three.js',      keywords: ['three.js', 'threejs'] },
  { name: 'CSS3',          keywords: ['css3', 'css '] },
  { name: 'HTML5',         keywords: ['html5', 'html '] },
];

// Platform name mapping: file suffix → display name
const PLATFORM_NAME_MAP = {
  '51job':   '前程无忧',
  'zhaopin': '智联招聘',
  'boss':    'BOSS直聘',
};

// Words that indicate a skill is "preferred / bonus" rather than required
const OPTIONAL_MARKERS = ['优先', '加分', 'preferred'];

// ---------------------------------------------------------------------------
// Layer 1 — match against structured jobTags array
// ---------------------------------------------------------------------------
/**
 * Returns true if any tag in the jobTags array matches any keyword of the skill.
 * @param {string[]} jobTags
 * @param {string[]} keywords
 * @returns {boolean}
 */
function matchTags(jobTags, keywords) {
  if (!Array.isArray(jobTags) || jobTags.length === 0) return false;
  return jobTags.some((tag) => {
    const lowerTag = String(tag).toLowerCase();
    return keywords.some((kw) => lowerTag.includes(kw));
  });
}

// ---------------------------------------------------------------------------
// Layer 2 — match against "任职要求 / 岗位要求" paragraph in jobDescribe HTML
// ---------------------------------------------------------------------------

/**
 * Strip HTML tags and decode basic entities, returning plain text.
 * @param {string} html
 * @returns {string}
 */
function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Extract the "requirements" section from jobDescribe HTML.
 * Looks for lines/paragraphs containing "任职要求" or "岗位要求" as a heading,
 * then collects text until the next heading-like line.
 * Falls back to the full text when no such section is found.
 * @param {string} html
 * @returns {string}
 */
function extractRequirementsText(html) {
  if (!html || typeof html !== 'string') return '';

  const fullText = stripHtml(html);

  // Split into lines for section detection
  const lines = fullText.split(/\n|。/).map((l) => l.trim()).filter(Boolean);

  const headingRe = /任职要求|岗位要求/;
  // A "heading" line is short (≤ 20 chars) and contains section keywords
  const nextHeadingRe = /职责|工作内容|岗位职责|福利|待遇|薪资|公司介绍/;

  let inSection = false;
  const sectionLines = [];

  for (const line of lines) {
    if (!inSection) {
      if (headingRe.test(line)) {
        inSection = true;
        // Include the heading line itself (often contains inline requirements)
        sectionLines.push(line);
      }
    } else {
      // Stop at the next heading-like line
      if (nextHeadingRe.test(line) && line.length <= 30) {
        break;
      }
      sectionLines.push(line);
    }
  }

  if (sectionLines.length > 0) {
    return sectionLines.join(' ');
  }

  // Fallback: return full text
  return fullText;
}

/**
 * Returns true if the keyword hit at `index` in `text` is surrounded by
 * optional markers within a 60-character window (meaning it's a "nice to have").
 * @param {string} text  - lowercase full section text
 * @param {number} index - start index of the keyword match
 * @param {string} keyword
 * @returns {boolean}
 */
function isOptionalHit(text, index, keyword) {
  const windowStart = Math.max(0, index - 60);
  const windowEnd = Math.min(text.length, index + keyword.length + 60);
  const window = text.slice(windowStart, windowEnd);
  return OPTIONAL_MARKERS.some((marker) => window.includes(marker));
}

/**
 * Returns true if the skill has a required (non-optional) match in the text.
 * @param {string} sectionText - already lowercased
 * @param {string[]} keywords
 * @returns {boolean}
 */
function matchDesc(sectionText, keywords) {
  for (const kw of keywords) {
    let searchFrom = 0;
    while (true) {
      const idx = sectionText.indexOf(kw, searchFrom);
      if (idx === -1) break;
      if (!isOptionalHit(sectionText, idx, kw)) {
        return true; // found a required mention
      }
      searchFrom = idx + kw.length;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Per-platform analysis — extracted as a reusable function
// ---------------------------------------------------------------------------

/**
 * Analyze a list of job objects and return skill statistics.
 * @param {object[]} jobs
 * @returns {{ sample: number, skills: object }}
 */
function analyzePlatform(jobs) {
  const sample = jobs.length;

  const counts = {};
  for (const skill of SKILLS) {
    counts[skill.name] = { tags: 0, desc: 0 };
  }

  for (const job of jobs) {
    const jobTags = Array.isArray(job.jobTags) ? job.jobTags : [];
    const descHtml = typeof job.jobDescribe === 'string' ? job.jobDescribe : '';
    const requirementsText = extractRequirementsText(descHtml).toLowerCase();

    for (const skill of SKILLS) {
      const { name, keywords } = skill;

      // Layer 1 — jobTags
      if (matchTags(jobTags, keywords)) {
        counts[name].tags += 1;
        continue; // Layer 2 skipped when Layer 1 already hits
      }

      // Layer 2 — jobDescribe requirements section
      if (requirementsText && matchDesc(requirementsText, keywords)) {
        counts[name].desc += 1;
      }
    }
  }

  // Build skills map — only include skills with total > 0, sorted by total desc
  const skillsEntries = SKILLS
    .map((skill) => {
      const { tags, desc } = counts[skill.name];
      const total = tags + desc;
      const pct = Math.round((total / sample) * 100);
      return [skill.name, { tags, desc, total, pct }];
    })
    .filter(([, v]) => v.total > 0)
    .sort(([, a], [, b]) => b.total - a.total);

  return {
    sample,
    skills: Object.fromEntries(skillsEntries),
  };
}

// ---------------------------------------------------------------------------
// Discover platform data files
// ---------------------------------------------------------------------------

/**
 * Scan workDir for raw_jobs_*.json files.
 * Returns an array of { filePath, platformName } objects.
 * Falls back to raw_jobs.json (as 前程无忧) if no multi-platform files found.
 * @param {string} workDir
 * @returns {{ filePath: string, platformName: string }[]}
 */
function discoverPlatformFiles(workDir) {
  const multiPlatformRe = /^raw_jobs_(.+)\.json$/;
  let entries;

  try {
    entries = fs.readdirSync(workDir);
  } catch (err) {
    console.error('[analyze] 错误：无法读取项目根目录 —', err.message);
    process.exit(1);
  }

  const platformFiles = entries
    .map((filename) => {
      const match = filename.match(multiPlatformRe);
      if (!match) return null;
      const suffix = match[1];
      const platformName = PLATFORM_NAME_MAP[suffix] || suffix;
      return { filePath: path.join(workDir, filename), platformName };
    })
    .filter(Boolean);

  if (platformFiles.length > 0) {
    return platformFiles;
  }

  // Fallback: try legacy raw_jobs.json
  const legacyPath = path.join(workDir, 'raw_jobs.json');
  if (fs.existsSync(legacyPath)) {
    console.log('[analyze] 未找到 raw_jobs_*.json，回退使用旧版 raw_jobs.json（平台：前程无忧）');
    return [{ filePath: legacyPath, platformName: '前程无忧' }];
  }

  console.error(
    '[analyze] 错误：未找到任何数据文件（raw_jobs_*.json 或 raw_jobs.json），请先运行爬虫脚本。'
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const workDir = path.resolve(__dirname, '..');
  const dataDir = path.join(workDir, 'data');
  const today = new Date().toISOString().slice(0, 10);
  const reportPath = path.join(dataDir, `${today}.json`);
  const indexPath = path.join(dataDir, 'index.json');

  // 1. Discover platform files ---------------------------------------------------
  const platformFiles = discoverPlatformFiles(workDir);
  console.log(`[analyze] 发现 ${platformFiles.length} 个平台数据文件：${platformFiles.map((f) => f.platformName).join('、')}`);

  // 2. Determine keyword (from first successfully loaded file) -------------------
  let keyword = '前端';

  // 3. Analyze each platform -----------------------------------------------------
  const platforms = {};

  for (const { filePath, platformName } of platformFiles) {
    let jobs;
    try {
      const raw = await fs.promises.readFile(filePath, 'utf-8');
      jobs = JSON.parse(raw);
    } catch (err) {
      console.warn(`[analyze] 警告：读取 ${path.basename(filePath)} 失败，跳过该平台 —`, err.message);
      continue;
    }

    if (!Array.isArray(jobs) || jobs.length === 0) {
      console.warn(`[analyze] 警告：${path.basename(filePath)} 为空数组，跳过平台「${platformName}」`);
      continue;
    }

    // Extract keyword from job data (best-effort, only set once)
    if (keyword === '前端' && jobs[0]) {
      keyword = jobs[0].searchKeyword || jobs[0].keyword || '前端';
    }

    console.log(`[analyze] 正在分析平台「${platformName}」，共 ${jobs.length} 条岗位数据…`);
    const result = analyzePlatform(jobs);
    platforms[platformName] = result;
  }

  if (Object.keys(platforms).length === 0) {
    console.error('[analyze] 错误：所有平台数据均为空或读取失败，中止分析。');
    process.exit(1);
  }

  // 4. Build report object -------------------------------------------------------
  const report = {
    date: today,
    keyword,
    platforms,
  };

  // 5. Write report file ---------------------------------------------------------
  await fs.promises.mkdir(dataDir, { recursive: true });
  await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`[analyze] 报告已写入 ${reportPath}`);

  // 6. Update data/index.json ----------------------------------------------------
  let indexData = { dates: [], latest: '' };
  try {
    const raw = await fs.promises.readFile(indexPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.dates)) {
      indexData = parsed;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[analyze] 警告：读取 data/index.json 失败，将重新初始化 —', err.message);
    }
    // ENOENT is expected on first run — start fresh
  }

  // Deduplicate and sort dates ascending
  const datesSet = new Set(indexData.dates);
  datesSet.add(today);
  const sortedDates = Array.from(datesSet).sort();

  indexData.dates = sortedDates;
  indexData.latest = sortedDates[sortedDates.length - 1];

  await fs.promises.writeFile(indexPath, JSON.stringify(indexData, null, 2), 'utf-8');
  console.log(`[analyze] data/index.json 已更新，latest = ${indexData.latest}`);

  // 7. Print summary per platform ------------------------------------------------
  console.log('\n========== 分析摘要 ==========');
  for (const [platformName, { sample, skills }] of Object.entries(platforms)) {
    const skillsEntries = Object.entries(skills);
    const top5 = skillsEntries.slice(0, 5);
    console.log(`\n平台：${platformName}（共 ${sample} 条岗位）`);
    console.log('  Top 5 技能：');
    for (const [name, { tags, desc, total, pct }] of top5) {
      console.log(`    ${name.padEnd(14)} total=${total}  (tags=${tags}, desc=${desc})  ${pct}%`);
    }
  }

  const totalSample = Object.values(platforms).reduce((sum, p) => sum + p.sample, 0);
  console.log(`\n各平台样本总计：${totalSample} 条`);
  console.log('================================\n');
}

main();
