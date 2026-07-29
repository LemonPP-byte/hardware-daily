import RSSParser from 'rss-parser';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, '..', 'raw-feed.json');

const parser = new RSSParser({
  timeout: 15000,
  headers: { 'User-Agent': 'HardwareDaily/1.0 (RSS Reader)' }
});

// ===== 信息源配置 =====
const RSS_SOURCES = [
  // 成熟品牌动态
  { name: 'TechCrunch Hardware', url: 'https://techcrunch.com/category/hardware/feed/', source: 'TechCrunch' },
  { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', source: 'The Verge' },
  { name: 'Wired', url: 'https://www.wired.com/feed/rss', source: 'Wired' },
  // 设计/新锐品牌
  { name: 'Dezeen Technology', url: 'https://www.dezeen.com/technology/feed/', source: 'Dezeen' },
  { name: 'Core77', url: 'https://feeds.feedburner.com/core77/blog', source: 'Core77' },
  // Product Hunt (公开 RSS)
  { name: 'Product Hunt', url: 'https://www.producthunt.com/feed', source: 'Product Hunt' },
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
    const res = await fetch(`${HN_API}/topstories.json`);
    const ids = (await res.json()).slice(0, 30);

    const stories = await Promise.all(
      ids.map(id => fetch(`${HN_API}/item/${id}.json`).then(r => r.json()).catch(() => null))
    );

    // 筛选消费级硬件相关关键词
    const hwKeywords = /gadget|wearable|headphone|speaker|e-reader|smart home|smart ring|smart glass|earbuds|keyboard|3d print|drone|e-ink|display|portable|charger|kickstarter|crowdfund|robot vacuum|camera|watch|fitness|VR|AR|gaming|controller|desk|light|lamp|bicycle|scooter|ev |ebike/i;

    for (const story of stories) {
      if (!story || !story.title) continue;
      if (hwKeywords.test(story.title) || (story.score && story.score > 200)) {
        if (hwKeywords.test(story.title)) {
          results.push({
            title: story.title,
            summary: `HN Score: ${story.score} | ${story.descendants || 0} comments`,
            url: story.url || `https://news.ycombinator.com/item?id=${story.id}`,
            date: new Date(story.time * 1000).toISOString(),
            source: 'Hacker News',
            image: '',
            score: story.score || 0
          });
        }
      }
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
    try {
      const feed = await parser.parseURL(`https://www.reddit.com/r/${sub}/hot.rss?limit=10`);
      const posts = (feed.items || []).slice(0, 10).map(item => ({
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
    await new Promise(r => setTimeout(r, 2500));
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

  // 只保留最近 48 小时的内容
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const recent = allItems.filter(item => {
    if (!item.date) return true; // 没有日期的保留让 AI 判断
    return new Date(item.date).getTime() > cutoff;
  });

  console.log(`\n📊 总计抓取: ${allItems.length} 条, 48h内: ${recent.length} 条`);

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(recent, null, 2));
  console.log(`💾 保存到: ${OUTPUT_PATH}\n`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
