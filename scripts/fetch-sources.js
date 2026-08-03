import RSSParser from 'rss-parser';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, '..', 'raw-feed.json');

const UA = 'Mozilla/5.0 (compatible; HardwareDaily/1.1; +https://github.com/LemonPP-byte/hardware-daily)';

const parser = new RSSParser({
  timeout: 15000,
  headers: { 'User-Agent': UA }
});

// 保留最近 N 天的内容（用户要求：不必是当天，近几天或高热度都可以）
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 7);

/**
 * 带超时的 fetch。Node 内置 fetch 默认不超时，
 * 且响应体不消费的话 undici 的 keep-alive socket 不释放、进程退不出去。
 * 这两点是之前 run 挂死 4-6 小时、以及每次固定多花 10 分钟的原因。
 */
async function safeFetch(url, { timeout = 12000, headers = {} } = {}) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, ...headers },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout)
    });
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? `timeout ${timeout}ms` : err.message };
  }
  if (!res.ok) {
    // 必须把 body 丢掉，否则 socket 泄漏
    try { await res.arrayBuffer(); } catch {}
    return { ok: false, error: `HTTP ${res.status}` };
  }
  return res;
}

// ===== 信息源配置 =====
const RSS_SOURCES = [
  // 成熟品牌动态
  { name: 'TechCrunch Hardware', url: 'https://techcrunch.com/category/hardware/feed/', source: 'TechCrunch' },
  { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', source: 'The Verge' },
  { name: 'Wired', url: 'https://www.wired.com/feed/rss', source: 'Wired' },
  // 设计/新锐品牌
  { name: 'Dezeen Technology', url: 'https://www.dezeen.com/technology/feed/', source: 'Dezeen' },
  { name: 'Core77', url: 'https://feeds.feedburner.com/core77/blog', source: 'Core77' },
  // Product Hunt
  { name: 'Product Hunt', url: 'https://www.producthunt.com/feed', source: 'Product Hunt' },
  // 充电/配件/智能硬件相关
  { name: '9to5Mac', url: 'https://9to5mac.com/feed/', source: '9to5Mac' },
  // ChargerLAB 的 RSS 已下线（/feed/、/en/feed/、wp-json 全部 404），换成 GSMArena
  { name: 'GSMArena', url: 'https://www.gsmarena.com/rss-news-reviews.php3', source: 'GSMArena' },
  { name: 'Android Authority', url: 'https://www.androidauthority.com/feed/', source: 'Android Authority' },
  { name: 'Engadget', url: 'https://www.engadget.com/rss.xml', source: 'Engadget' },
  { name: 'Yanko Design', url: 'https://www.yankodesign.com/feed/', source: 'Yanko Design' },
];

const HN_API = 'https://hacker-news.firebaseio.com/v0';
const PRODUCTHUNT_URL = 'https://www.producthunt.com';
const REDDIT_SUBS = ['hardware', 'gadgets', 'singularity'];

// ===== RSS 抓取 =====
async function fetchRSS() {
  const results = [];
  for (const source of RSS_SOURCES) {
    try {
      const feed = await parser.parseURL(source.url);
      const items = (feed.items || []).slice(0, 10).map(item => ({
        title: item.title || '',
        summary: item.contentSnippet || item.content || '',
        url: item.link || '',
        date: item.isoDate || item.pubDate || '',
        source: source.source,
        image: extractImage(item) || ''
      }));
      results.push(...items);
      console.log(`  ✓ ${source.name}: ${items.length} items`);
    } catch (err) {
      console.log(`  ✗ ${source.name}: ${err.message}`);
    }
  }
  return results;
}

function extractImage(item) {
  // Try enclosure
  if (item.enclosure && item.enclosure.url) return item.enclosure.url;
  // Try media content
  if (item['media:content'] && item['media:content'].$.url) return item['media:content'].$.url;
  // Try to find first image in content
  const match = (item.content || item['content:encoded'] || '').match(/<img[^>]+src=["']([^"']+)["']/);
  return match ? match[1] : '';
}

// ===== Hacker News 抓取 =====
async function fetchHackerNews() {
  const results = [];
  try {
    const res = await safeFetch(`${HN_API}/topstories.json`, { timeout: 10000 });
    if (!res.ok) throw new Error(res.error);
    const ids = (await res.json()).slice(0, 50);

    const stories = await Promise.all(
      ids.map(async id => {
        const r = await safeFetch(`${HN_API}/item/${id}.json`, { timeout: 8000 });
        if (!r.ok) return null;
        return r.json().catch(() => null);
      })
    );

    // 筛选消费级硬件相关关键词
    // 注意：短词必须加词边界。原版写成 `VR|AR|ev ` 没有边界，
    // 结果 "ar" 会命中 Spark / Years / parser / Search / Market / Article 等等，
    // 实测 16 条 HN 里 15 条是靠这个误匹配进来的 —— 等于过滤从未生效。
    const hwKeywords = new RegExp([
      // 多词短语本身够长，不需要边界
      'smart home', 'smart ring', 'smart glass', 'robot vacuum', '3d print',
      'e-reader', 'e-ink', 'e-bike',
      // 单词加词边界
      '\\b(gadget|gadgets)\\b', '\\bwearable', '\\bheadphones?\\b', '\\bspeakers?\\b',
      '\\bearbuds?\\b', '\\bkeyboards?\\b', '\\bdrones?\\b', '\\bdisplays?\\b',
      '\\bportable\\b', '\\bchargers?\\b', '\\bcharging\\b', '\\bkickstarter\\b',
      '\\bcrowdfund', '\\bcameras?\\b', '\\bsmartwatch', '\\bfitness\\b',
      '\\bVR\\b', '\\bAR\\b', '\\bXR\\b', '\\bheadset', '\\bgaming\\b',
      '\\bcontrollers?\\b', '\\blaptops?\\b', '\\btablets?\\b', '\\bphones?\\b',
      '\\bsmartphones?\\b', '\\brobots?\\b', '\\bdesks?\\b', '\\blamps?\\b',
      '\\bbicycles?\\b', '\\bscooters?\\b', '\\bebikes?\\b', '\\bbatter(y|ies)\\b',
      '\\bUSB\\b', '\\bGaN\\b', '\\bMagSafe\\b', '\\bpower bank\\b', '\\bdock\\b',
      // 补充：图拉斯品类相关 + 之前漏掉的常见品类
      '\\bmouse\\b', '\\bmice\\b', '\\be-?paper\\b', '\\bmonitors?\\b',
      '\\bprojectors?\\b', '\\bcables?\\b', '\\badapters?\\b', '\\bhubs?\\b',
      '\\bphone case\\b', '\\bpower supply\\b', '\\bthermal\\b', '\\bcooler\\b',
      '\\bkindle\\b', '\\bairpods\\b', '\\bhandheld\\b', '\\bconsoles?\\b',
    ].join('|'), 'i');

    // 纯软件/开发向的域名和标题，即使高热度也不要 —— 之前放开高热度后
    // 灌进来 Karpathy 的鹈鹕 SVG benchmark、NixOS 配置仓库这类东西，
    // AI 为了凑满「AI 硬件」那一层就把它们硬说成硬件产品。
    const softwareHosts = /^(github\.com|gitlab\.com|twitter\.com|x\.com|arxiv\.org|news\.ycombinator\.com|stackoverflow\.com|npmjs\.com|pypi\.org|huggingface\.co)$/i;
    // 只保留在硬件语境下也不可能有歧义的词。
    // 删掉了 framework（Framework 是笔记本品牌）、library / package / API / SDK / CLI /
    // kernel / open-source / prompt —— 这些在硬件报道里会正常出现。
    const softwareTitle = /\b(benchmark|LLM|nixos|linux distro|npm|pypi|docker|kubernetes|regex|SQL|compiler|self.?hosted?|programming language|source code)\b/i;

    for (const story of stories) {
      if (!story || !story.title) continue;

      // HN 是通用技术论坛，绝大多数内容是软件，所以硬件关键词是硬门槛。
      // 高热度只用来豁免 7 天时间窗口（见 main() 里的 item.hot），不豁免相关性 ——
      // 之前让高热度绕过关键词，结果 Karpathy 的鹈鹕 SVG benchmark 被推成了 AI 硬件。
      // 大厂硬件动态本来就由 11 个 RSS 源覆盖，HN 只是补充，宁可漏不可错。
      if (!hwKeywords.test(story.title)) continue;

      // 软件内容排除对所有 HN 条目生效（"pelican on a bicycle" 会命中 bicycle，
      // 但标题里的 benchmark 说明它是软件话题）
      let host = '';
      try { host = new URL(story.url || '').hostname.replace(/^www\./, ''); } catch {}
      if (softwareHosts.test(host) || softwareTitle.test(story.title)) continue;

      const isHot = (story.score || 0) > 200;
      results.push({
        title: story.title,
        summary: `HN Score: ${story.score} | ${story.descendants || 0} comments`,
        url: story.url || `https://news.ycombinator.com/item?id=${story.id}`,
        date: new Date(story.time * 1000).toISOString(),
        source: 'Hacker News',
        image: '',
        score: story.score || 0,
        hot: isHot
      });
    }
    console.log(`  ✓ Hacker News: ${results.length} hardware items`);
  } catch (err) {
    console.log(`  ✗ Hacker News: ${err.message}`);
  }
  return results;
}

// ===== Reddit 抓取 (via RSS to avoid API blocks) =====
async function fetchReddit() {
  const results = [];
  for (const sub of REDDIT_SUBS) {
    let feed = null;
    // Reddit 对 CI 机房 IP 限流很凶（之前 3 个 sub 有 2 个 429）。
    // 429 是秒回，所以重试 2 次、退避 7 秒足够，再多只是白等。
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        feed = await parser.parseURL(`https://www.reddit.com/r/${sub}/hot.rss?limit=15`);
        break;
      } catch (err) {
        if (attempt === 2) {
          console.log(`  ✗ Reddit r/${sub}: ${err.message} (重试 2 次均失败)`);
        } else {
          await new Promise(r => setTimeout(r, 7000));
        }
      }
    }
    if (!feed) { await new Promise(r => setTimeout(r, 4000)); continue; }
    try {
      const posts = (feed.items || []).slice(0, 12).map(item => ({
        title: item.title || '',
        summary: item.contentSnippet?.slice(0, 200) || `r/${sub}`,
        url: item.link || '',
        date: item.isoDate || '',
        source: 'Reddit',
        image: ''
      }));
      results.push(...posts);
      console.log(`  ✓ Reddit r/${sub}: ${posts.length} items`);
    } catch (err) {
      console.log(`  ✗ Reddit r/${sub}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 4000));
  }
  return results;
}

// ===== 主流程 =====
async function main() {
  console.log('\n🔍 开始抓取信息源...\n');
  console.log('[RSS Feeds]');
  const rssItems = await fetchRSS();
  console.log('\n[Hacker News]');
  const hnItems = await fetchHackerNews();
  console.log('\n[Reddit]');
  const redditItems = await fetchReddit();

  const allItems = [...rssItems, ...hnItems, ...redditItems];

  // 保留最近 WINDOW_DAYS 天（默认 7 天）的内容。
  // 高热度内容（HN >200 分）即使超出窗口也保留 —— 不强求是当天新闻。
  const cutoff = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const seen = new Set();
  const recent = allItems.filter(item => {
    // 顺手去重（同一条新闻常被多个源转载）
    const key = (item.url || item.title || '').replace(/[?#].*$/, '').toLowerCase();
    if (key && seen.has(key)) return false;
    if (key) seen.add(key);

    if (item.hot) return true;          // 高热度直接留
    if (!item.date) return true;        // 没日期的留给 AI 判断
    const t = new Date(item.date).getTime();
    if (Number.isNaN(t)) return true;
    return t > cutoff;
  });

  // 新鲜的排前面，让 AI 在同等质量下更容易挑到近的
  recent.sort((a, b) => {
    const ta = a.date ? new Date(a.date).getTime() : 0;
    const tb = b.date ? new Date(b.date).getTime() : 0;
    return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta);
  });

  console.log(`\n📊 总计抓取: ${allItems.length} 条, 去重后 ${WINDOW_DAYS} 天内: ${recent.length} 条`);
  if (recent.length < 10) {
    console.log('::warning::候选内容偏少，可能多个信息源抓取失败');
  }

  // 对没有图片的文章，尝试从页面 og:image 获取封面图
  console.log('\n[补充封面图]');
  let fetched = 0;
  for (const item of recent) {
    if (item.image || !item.url) continue;
    if (fetched >= 20) break; // 限制请求数量
    try {
      const res = await safeFetch(item.url, { timeout: 8000 });
      if (!res.ok) continue;
      const html = await res.text();
      // 提取 og:image
      const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
      if (ogMatch && ogMatch[1]) {
        item.image = ogMatch[1];
        fetched++;
        console.log(`  ✓ ${item.title.slice(0, 40)}...`);
      }
    } catch (err) {
      // 静默跳过
    }
  }
  console.log(`  补充了 ${fetched} 张封面图`);

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(recent, null, 2));
  console.log(`\n💾 保存到: ${OUTPUT_PATH}\n`);
}

main()
  .then(() => process.exit(0))   // 显式退出：undici 的 keep-alive socket 会让进程多挂 ~10 分钟
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
