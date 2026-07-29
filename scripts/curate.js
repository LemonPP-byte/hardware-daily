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

const TODAY = new Date().toISOString().split('T')[0];

async function callLLM(prompt) {
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
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DeepSeek API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
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

  const itemList = rawItems.map((item, i) => (
    `[${i}] ${item.title}\n    来源: ${item.source} | ${item.url}\n    摘要: ${item.summary?.slice(0, 150)}`
  )).join('\n\n');

  // 读取昨日数据（用于判断是否有持续热议的内容）
  let existingData = [];
  if (fs.existsSync(DATA_PATH)) {
    existingData = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  }
  const yesterdayItems = existingData.length > 0 ? existingData[0].items.map(i => i.title) : [];
  const yesterdayContext = yesterdayItems.length > 0
    ? `\n\n昨日已选内容（如果某条今天仍在多个源被讨论，可以再次入选并标记 recurring=true）：\n${yesterdayItems.map(t => `- ${t}`).join('\n')}`
    : '';

  const prompt = `你是一个消费硬件产品经理的每日选品助手。从以下今日抓取的内容中，选出最值得关注的 9 条，并为每条评分。

你的目标用户是：图拉斯（Torras）品牌的产品经理，图拉斯聚焦充电类和智能硬件类产品。关注「什么新产品能打动消费者」「什么新形态能激发购买欲」。

内容筛选权重：
- 70% 基于内容本身的新颖性、讨论热度、消费者吸引力
- 30% 基于与图拉斯品类的相关度（充电配件、无线充电、MagSafe生态、手机壳、散热、车载配件、智能穿戴配件、3C消费硬件）

9 条内容的结构（严格按此分层，按顺序排列）：
- 第 1 条【每日头条】：今天最值得关注的一条消费硬件动态，优先选与充电/智能硬件/3C配件/大众消费需求高度相关的。这条会作为 hero banner 展示，需要特别有冲击力。
- 第 2-3 条【成熟品牌】：已有市场验证的品牌的新品动态（如 Apple、Samsung、Anker、Belkin、Sony、Dyson、Nothing、Bose 等）。优先选充电/配件/智能硬件相关。
- 第 4-5 条【AI 硬件】：和 AI 相关的消费级硬件产品——AI 耳机、AI 眼镜、AI 玩具、AI 宠物设备、AI 相机、AI 穿戴、AI 家居设备等。必须是实体硬件产品。
- 第 6-7 条【新锐产品】：已有实际交付能力或众筹成绩亮眼（$50k+）的新品牌/新产品。
- 第 8-9 条【野生灵感】：更发散的小众设计品、硬件创新、品牌跨界。

选择标准：
1. 必须是具体可感知的消费级硬件产品
2. 有新意的产品形态或使用场景
3. 在海外已有消费者讨论和购买意愿

排除标准（严格执行）：
- 行业趋势/市场分析/宏观预测
- 技术原理/芯片/协议/开发者工具
- 企业级/工业级/B2B
- 纯软件/APP/AI 模型
- 融资新闻/政策/公司战略
- 纯概念、无法购买、无交付时间的空想产品

评分规则（1-5分）：
- 5分：全新品类定义 + 社区爆发式讨论（500+）+ 强购买欲
- 4分：明确新意 + 多平台讨论 + 消费者积极
- 3分：值得关注 + 1-2个平台讨论
- 2分：常规新品但有亮点
- 1分：小众或争议大

链接要求（极其重要）：
- URL 必须是候选内容中的原始具体文章/产品页链接，原封不动复制
- 绝对不能改写 URL、不能缩短、不能指向网站首页
- 如果候选内容的 URL 本身就是首页（如 producthunt.com 而非具体产品页），则不选这条

跨日复现规则：昨日内容若今天在新平台继续被讨论，可再次入选标记 recurring=true。
${yesterdayContext}

候选内容：
${itemList}

请返回严格的 JSON 数组，包含 9 个对象（按上述 1-2-3-4-5-6-7-8-9 结构排列），每个对象字段：
- "index": 原始编号（整数）
- "brief": 一段式概要（40-60字，把产品名、卖点、为什么值得关注融合成一段话。用 **加粗** 标记其中最关键的产品名或核心卖点，最多加粗2处。例："**Ozlo Sleepbuds 2** 是 Bose 睡眠耳塞的精神续作，续航翻倍且支持自定义白噪音混搭，海外失眠社区反响热烈。"）
- "url": 候选内容中的原始链接（直接复制，不可修改）
- "source": 来源名称
- "score": 评分（1-5整数）
- "recurring": 是否为跨日复现内容（true/false）
- "tier": 层级标签（"每日头条" / "成熟品牌" / "AI 硬件" / "新锐产品" / "野生灵感"）

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
  const tierByPosition = ['每日头条','成熟品牌','成熟品牌','AI 硬件','AI 硬件','新锐产品','新锐产品','野生灵感','野生灵感'];
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
      const res = await fetch(item.url, {
        headers: { 'User-Agent': 'HardwareDaily/1.0' },
        redirect: 'follow',
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) continue;
      const html = await res.text();
      const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
      if (ogMatch && ogMatch[1]) {
        item.image = ogMatch[1];
        console.log(`  ✓ ${item.title}`);
      } else {
        console.log(`  ✗ ${item.title} (no og:image found)`);
      }
    } catch (err) {
      console.log(`  ✗ ${item.title} (${err.message})`);
    }
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

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
