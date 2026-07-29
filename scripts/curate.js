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

  const prompt = `你是一个消费硬件产品经理的每日选品助手。从以下今日抓取的内容中，选出最值得关注的 5 条，并为每条评分。

你的目标用户是：消费电子/硬件产品经理，关注「什么新产品能打动消费者」「什么新形态能激发购买欲」。

选择标准（严格按优先级）：
1. 具体的、可购买或即将可购买的消费级硬件产品（耳机、音箱、智能家居、穿戴设备、创意配件、个护电器、出行工具等）
2. 有新意的产品形态或使用场景——不是「更快更强」而是「原来还能这样用」
3. 品牌跨界联名、设计师合作款、创意众筹项目
4. 在海外已经有消费者讨论和购买意愿的

排除标准（严格执行，不要选）：
- 行业趋势报告、市场分析、宏观预测
- 技术原理、芯片发布、协议更新、开发者工具
- 企业级/工业级/B2B 设备
- 纯软件、APP、AI 模型发布
- 融资新闻（除非产品本身值得关注）
- 政策、监管、公司战略层面的新闻

评分规则（1-5分，必须严格执行）：
- 5分：全新品类定义 + 海外社区爆发式讨论（500+评论/upvote）+ 强购买欲
- 4分：产品有明确新意 + 多个平台同时讨论 + 消费者反应积极
- 3分：值得关注的新品 + 在1-2个平台有讨论 + 有一定吸引力
- 2分：常规新品但有亮点 + 少量讨论
- 1分：有点意思但偏小众或争议大

跨日复现规则：如果昨日某条内容今天在新的平台继续被大量讨论，或有重大更新，可以再次入选，标记 recurring=true，分数可以变化。
${yesterdayContext}

候选内容：
${itemList}

请返回严格的 JSON 数组，包含 5 个对象（按分数从高到低排列），每个对象字段：
- "index": 原始编号（整数）
- "title": 中文标题（产品名+一句话卖点，15字以内）
- "summary": 中文摘要（2-3句话，说清楚这是什么产品、为什么有趣、海外消费者反应如何）
- "url": 原始文章/产品页链接（必须是候选内容中的具体URL，不能改成首页）
- "source": 来源名称
- "score": 评分（1-5整数）
- "recurring": 是否为跨日复现内容（true/false）

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
    console.log(`  ${i + 1}. [${stars}] ${item.title}${tag}`);
    console.log(`     ${item.source} → ${item.url}`);
    console.log('');
  });

  // 构造今日数据
  const todayEntry = {
    date: TODAY,
    items: selected.map(item => ({
      title: item.title,
      summary: item.summary,
      url: item.url,
      source: item.source,
      score: item.score || 3,
      recurring: item.recurring || false
    }))
  };

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
