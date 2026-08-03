import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW_PATH = path.join(__dirname, '..', 'raw-feed.json');
const DATA_PATH = path.join(__dirname, '..', 'data.json');

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
if (!DEEPSEEK_API_KEY) {
  console.error('❌ 缺少 DEEPSEEK_API_KEY 环境变量');
  process.exit(1);
}

// 用北京时区取日期。之前用 UTC，而 cron 在北京时间清晨触发时 UTC 还是前一天，
// 导致页面上的日期永远比实际慢一天。
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });

async function callLLM(prompt, { retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          max_tokens: 2000,
          temperature: 0.3,
          messages: [{ role: 'user', content: prompt }]
        }),
        // 没有超时的话，API 卡住会让整个 job 挂到 6 小时上限
        signal: AbortSignal.timeout(120000)
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`DeepSeek API error ${res.status}: ${err.slice(0, 300)}`);
      }

      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('DeepSeek 返回内容为空');
      return content;
    } catch (err) {
      lastErr = err;
      const reason = err.name === 'TimeoutError' ? '超时 120s' : err.message;
      console.log(`  ⚠ LLM 第 ${attempt}/${retries} 次调用失败: ${reason}`);
      if (attempt < retries) await new Promise(r => setTimeout(r, attempt * 8000));
    }
  }
  throw lastErr;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 带超时、且失败时消费掉 body 的 fetch（不消费会泄漏 socket，让进程退不出去）
async function safeFetch(url, { timeout = 10000, headers = {} } = {}) {
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
    try { await res.arrayBuffer(); } catch {}
    return { ok: false, error: `HTTP ${res.status}` };
  }
  return res;
}

// 从 brief 中提取产品名（加粗部分）
function extractProductName(brief) {
  const match = brief.match(/\*\*([^*]+)\*\*/);
  if (match) return match[1];
  // fallback: 取前20个字
  return brief.replace(/\*\*/g, '').slice(0, 20);
}

// 通过搜索引擎获取产品图片
async function searchProductImage(query) {
  // 策略1: 尝试从 Google 搜索结果页提取图片
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query + ' product image')}&tbm=isch`;
  try {
    const res = await safeFetch(searchUrl, { timeout: 10000 });
    if (res.ok) {
      const html = await res.text();
      // 提取搜索结果中的图片URL
      const imgMatches = html.match(/\["(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)",\d+,\d+\]/i);
      if (imgMatches && imgMatches[1]) return imgMatches[1];
    }
  } catch (e) { /* continue to next strategy */ }

  // 策略2: 尝试从产品官网/媒体站点获取
  const mediaSites = [
    `https://www.theverge.com/search?q=${encodeURIComponent(query)}`,
    `https://techcrunch.com/?s=${encodeURIComponent(query)}`
  ];
  for (const url of mediaSites) {
    try {
      const res = await safeFetch(url, { timeout: 8000 });
      if (!res.ok) continue;
      const html = await res.text();
      const ogMatch = html.match(/<img[^>]+src=["'](https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp)[^"']*?)["'][^>]*>/i);
      if (ogMatch && ogMatch[1] && ogMatch[1].length > 30) return ogMatch[1];
    } catch (e) { continue; }
  }

  return null;
}

async function main() {
  console.log('\n🤖 AI 筛选开始...\n');

  // 读取抓取数据
  if (!fs.existsSync(RAW_PATH)) {
    console.error('❌ raw-feed.json 不存在，请先运行 fetch-sources.js');
    process.exit(1);
  }
  const rawItems = JSON.parse(fs.readFileSync(RAW_PATH, 'utf-8'));
  console.log(`📥 读入 ${rawItems.length} 条候选内容`);

  // 给每条标注距今天数，让 AI 知道新鲜度（但不强制只能选当天的）
  const daysAgo = (dateStr) => {
    if (!dateStr) return null;
    const t = new Date(dateStr).getTime();
    if (Number.isNaN(t)) return null;
    return Math.max(0, Math.floor((Date.now() - t) / 86400000));
  };

  const itemList = rawItems.map((item, i) => {
    const d = daysAgo(item.date);
    const fresh = d === null ? '时间未知' : d === 0 ? '今天' : `${d} 天前`;
    const hot = item.score ? ` | 热度 ${item.score}` : '';
    return `[${i}] ${item.title}\n    来源: ${item.source} | ${fresh}${hot} | ${item.url}\n    摘要: ${item.summary?.slice(0, 150)}`;
  }).join('\n\n');

  // 读取昨日数据（用于判断是否有持续热议的内容）
  let existingData = [];
  if (fs.existsSync(DATA_PATH)) {
    existingData = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  }
  // 候选窗口放宽到 7 天后，去重也要看最近 5 天，否则容易连着几天推同一条
  const recentlyPushed = existingData
    .slice(0, 5)
    .flatMap(d => (d.items || []).map(i => `${d.date}: ${(i.brief || '').replace(/\*\*/g, '').slice(0, 60)}`));
  const yesterdayContext = recentlyPushed.length > 0
    ? `\n\n最近 5 天已推送过的内容（**不要重复选择这些**，除非它现在有了重大新进展且仍在被热议，那种情况标记 recurring=true）：\n${recentlyPushed.map(t => `- ${t}`).join('\n')}`
    : '';

  const prompt = `你是一个消费硬件产品经理的每日选品助手。从以下近期抓取的内容中，选出最值得关注的 7 条，并为每条评分。

═══ 时效性说明（重要）═══
候选内容来自最近约 7 天，每条都标注了距今天数。**不要求必须是当天发生的新闻。**
判断优先级：内容质量与品类相关度 > 时效性。
- 优先选 3 天内的内容
- 3-7 天前的内容，只要质量高、讨论热度高、你判断读者可能还没看到，同样可以选
- 高热度内容（标注了热度分数的）即使更早也值得考虑
- 宁可选一条 5 天前的优质充电类产品，也不要为了「今天」而凑一条无关的当天新闻
- 只有在候选池确实没有更好选择时，才降低质量标准

你的目标用户是：图拉斯（Torras）品牌的产品经理，图拉斯聚焦充电类、3C配件类和智能硬件类产品。关注「什么新产品能打动消费者」「什么新形态能激发购买欲」「行业头部玩家的动向如何影响行业格局」。

═══ 内容筛选漏斗 ═══

【第一层：品类相关度权重 30%-50%】
以下品类与图拉斯业务直接相关，在同等质量下优先选入：
- 充电类：无线充电器、充电宝、充电线、GaN充电头、MagSafe配件、车载充电
- 3C配件类：手机壳、散热器、支架、保护膜、转接头、扩展坞、数据线
- 科技硬件：智能穿戴（手表/耳机/眼镜）、智能家居硬件、便携音频
- AI硬件产品：AI可穿戴、AI陪伴设备、AI相机、具身智能/机器人
- 头部厂家行业动向：Apple/Samsung/Google/Anker/Belkin/Sony/Dyson/Nothing/OpenAI 等大厂的产品发布、战略调整、生态变化——这些会直接影响行业格局和供应链方向

【第二层：内容质量 50%-70%】
- 产品新颖性：是否有新形态、新交互、新场景？
- 社区讨论热度：Reddit/HN/论坛的评论数和积极程度
- 消费者吸引力：是否能激发购买欲？有无明确定价和交付？
- 行业影响力：头部品牌的动作是否会改变竞争格局？

═══ 输出结构（严格 7 条）═══

- 第 1 条【每日头条】：整个候选池里最值得关注的一条（不必是当天发生的）。优先级：充电/3C配件/AI硬件 > 头部品牌重大动态 > 其他高热度消费硬件。这条会作为大尺寸 hero 展示。
  注意：必须严格按上述顺序返回，第一个对象的 tier 必须是"每日头条"。
- 第 2-3 条【成熟品牌】：已有市场验证的品牌新品动态（Apple、Samsung、Anker、Belkin、Sony、Dyson、Nothing、Bose、Google、Huawei等）。优先选充电/配件/智能硬件/AI相关，以及影响行业走向的重大发布。
- 第 4-5 条【AI 硬件】：AI相关的消费级实体硬件——AI可穿戴、AI陪伴设备、AI相机、具身智能/机器人、AI交互终端。必须有实体硬件载体。
- 第 6-7 条【新锐产品】：3C创新配件、充电新形态、新锐智能设备、高潜力新品牌产品。必须与3C/充电/AI/科技硬件相关。

═══ 选择标准 ═══
1. 必须是具体可感知的消费级硬件产品或硬件相关动态
2. 有新意的产品形态或使用场景
3. 在海外已有消费者讨论和购买意愿
4. 头部厂家的战略动向（即使不是具体新品）可以入选——因为它会影响图拉斯的产品规划

═══ 排除标准（严格执行）═══
- 行业宏观预测/市场报告（但具体品牌的产品战略可以）
- 纯芯片/协议/开发者工具
- 企业级/工业级/B2B
- 纯软件/APP/AI模型（无硬件载体的）
- 融资新闻/政策
- 纯概念无交付的空想产品
- 与3C/充电/AI/科技硬件完全无关的（如纯家具、食品、服饰）

═══ 评分规则（1-5分）═══
- 5分：全新品类定义 + 社区爆发式讨论（500+）+ 强购买欲 + 与图拉斯品类高度相关
- 4分：明确新意 + 多平台讨论 + 消费者积极
- 3分：值得关注 + 1-2个平台讨论
- 2分：常规新品但有亮点
- 1分：小众或争议大

═══ 链接要求（极其重要）═══
- URL 必须是候选内容中的原始具体文章/产品页链接，原封不动复制
- 绝对不能改写 URL、不能缩短、不能指向网站首页

跨日复现规则：已推送过的内容若仍在被热议，可再次入选并标记 recurring=true，但同一条最多复现一次，避免连续多天重复。
${yesterdayContext}

候选内容：
${itemList}

请返回严格的 JSON 数组，包含 7 个对象（按上述结构排列），每个对象字段：
- "index": 原始编号（整数）
- "brief": 一段式概要（40-60字，把产品名、卖点、为什么值得关注融合成一段话。用 **加粗** 标记其中最关键的产品名或核心卖点，最多加粗2处。）
- "url": 候选内容中的原始链接（直接复制，不可修改）
- "source": 来源名称
- "score": 评分（1-5整数）
- "recurring": 是否为跨日复现内容（true/false）
- "tier": 层级标签（"每日头条" / "成熟品牌" / "AI 硬件" / "新锐产品"）

只返回 JSON 数组，不要其他文字。`;

  const response = await callLLM(prompt);

  // 解析 AI 返回
  let selected;
  try {
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array found');
    selected = JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('❌ AI 返回解析失败:', err.message);
    console.error('原始返回:', response);
    process.exit(1);
  }

  console.log(`\n✅ AI 选出 ${selected.length} 条:\n`);
  selected.forEach((item, i) => {
    const stars = '●'.repeat(item.score) + '○'.repeat(5 - item.score);
    const tag = item.recurring ? ' [持续热议]' : '';
    const label = (item.brief || '').replace(/\*\*/g, '').slice(0, 40);
    console.log(`  ${i + 1}. [${stars}] ${label}...${tag}`);
    console.log(`     ${item.source} → ${item.url}`);
    console.log('');
  });

  // 构造今日数据（按位置补 tier fallback）
  const tierByPosition = ['每日头条','成熟品牌','成熟品牌','AI 硬件','AI 硬件','新锐产品','新锐产品'];
  const todayItems = selected.map((item, i) => {
    const rawItem = rawItems[item.index] || {};
    return {
      brief: item.brief || `**${item.title}** ${item.summary || ''}`,
      url: item.url,
      source: item.source,
      score: item.score || 3,
      recurring: item.recurring || false,
      tier: item.tier || tierByPosition[i] || '新锐产品',
      image: rawItem.image || ''
    };
  });

  // 对没有图片的条目，尝试从原文页面提取 og:image
  console.log('\n🖼️  补充缺失图片...');
  for (const item of todayItems) {
    if (item.image || !item.url) continue;
    try {
      const res = await safeFetch(item.url, { timeout: 10000 });
      if (!res.ok) throw new Error(res.error);
      const html = await res.text();
      const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
      if (ogMatch && ogMatch[1]) {
        item.image = ogMatch[1];
        console.log(`  ✓ ${item.brief?.slice(0, 30)} (og:image)`);
      } else {
        throw new Error('no og:image');
      }
    } catch (err) {
      // Fallback: 根据产品名搜索图片
      console.log(`  ⚠ ${item.brief?.slice(0, 30)} - og:image失败(${err.message})，尝试搜索...`);
      try {
        const productName = extractProductName(item.brief || '');
        if (productName) {
          const imgUrl = await searchProductImage(productName);
          if (imgUrl) {
            item.image = imgUrl;
            console.log(`  ✓ ${item.brief?.slice(0, 30)} (搜索: ${productName})`);
          } else {
            console.log(`  ✗ ${item.brief?.slice(0, 30)} (搜索无结果)`);
          }
        }
      } catch (searchErr) {
        console.log(`  ✗ ${item.brief?.slice(0, 30)} (搜索失败: ${searchErr.message})`);
      }
    }
  }

  // 最终检查：确保所有条目都有图片，无图的做最后尝试
  const noImageItems = todayItems.filter(i => !i.image);
  if (noImageItems.length > 0) {
    console.log(`\n⚠️  仍有 ${noImageItems.length} 条无图，进行最终搜索...`);
    for (const item of noImageItems) {
      try {
        const productName = extractProductName(item.brief || '') || item.source;
        const imgUrl = await searchProductImage(productName + ' product');
        if (imgUrl) {
          item.image = imgUrl;
          console.log(`  ✓ 最终补图: ${item.brief?.slice(0, 30)}`);
        }
      } catch (e) {
        // skip
      }
    }
  }

  // AI 有时不按顺序返回（8/1 那次头条排在第 4 位），这里强制按 tier 归位。
  // 前端是按 tier 取数据的，但排序对了更保险，也方便直接看 data.json。
  const tierOrder = { '每日头条': 0, '成熟品牌': 1, 'AI 硬件': 2, '新锐产品': 3, '野生灵感': 4 };
  todayItems.sort((a, b) => (tierOrder[a.tier] ?? 9) - (tierOrder[b.tier] ?? 9));

  // 如果 AI 一条都没标"每日头条"，把评分最高的提上去，否则前端 hero 位会空着
  if (!todayItems.some(i => i.tier === '每日头条') && todayItems.length > 0) {
    const best = todayItems.reduce((a, b) => (b.score > a.score ? b : a), todayItems[0]);
    best.tier = '每日头条';
    todayItems.sort((a, b) => (tierOrder[a.tier] ?? 9) - (tierOrder[b.tier] ?? 9));
    console.log('  ⚠ AI 未指定每日头条，已自动提升评分最高的一条');
  }

  const todayEntry = { date: TODAY, items: todayItems };

  // 如果今天已经有数据，替换；否则插入到最前面
  const todayIndex = existingData.findIndex(d => d.date === TODAY);
  if (todayIndex >= 0) {
    existingData[todayIndex] = todayEntry;
  } else {
    existingData.unshift(todayEntry);
  }

  // 只保留最近 30 天
  existingData = existingData.slice(0, 30);

  fs.writeFileSync(DATA_PATH, JSON.stringify(existingData, null, 2));
  console.log(`💾 data.json 已更新 (共 ${existingData.length} 天数据)\n`);
}

main()
  .then(() => process.exit(0))   // 显式退出，避免 keep-alive socket 拖住进程
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
