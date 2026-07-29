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

  // 构造 prompt
  const itemList = rawItems.map((item, i) => (
    `[${i}] ${item.title}\n    来源: ${item.source} | ${item.url}\n    摘要: ${item.summary?.slice(0, 150)}`
  )).join('\n\n');

  const prompt = `你是一个硬件产品经理的每日信息助手。从以下今日抓取的内容中，选出最值得关注的 3 条。

选择标准（按优先级）：
1. 消费级硬件优先——能让普通人产生购买欲望的产品、配件、生活场景设备
2. 带来新视角、新产品品类定义的（不是单纯参数升级或芯片迭代）
3. 有趣的品牌联动、跨界合作、设计师联名款
4. 在海外有一定讨论热度但国内还不太知道的
5. 和人的生活方式、消费场景强相关的 AI 硬件可以选，但不要纯技术/芯片/底层协议类

排除标准（不要选）：
- 纯技术论文、芯片架构、开发板、服务器硬件
- 企业级/工业级设备（除非它有明确的消费级转化故事）
- 纯软件产品
- 单纯的参数升级（更快的CPU、更大的内存）

候选内容：
${itemList}

请返回严格的 JSON 数组，包含 3 个对象，每个对象字段：
- "index": 原始编号（整数）
- "title": 中文标题（简洁有力，体现新意，20字以内）
- "summary": 中文摘要（2-3句话，说明这个东西为什么值得关注，要提到社区反应或舆论热度）
- "url": 原始链接
- "source": 来源名称
- "image_query": 一个用于搜索配图的英文关键词短语（3-5个词）

只返回 JSON 数组，不要其他文字。`;

  const response = await callLLM(prompt);

  // 解析 AI 返回
  let selected;
  try {
    // 尝试提取 JSON（AI 有时会包裹在 markdown 代码块里）
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
    console.log(`  ${i + 1}. ${item.title}`);
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
      image: `https://source.unsplash.com/600x400/?${encodeURIComponent(item.image_query)}`
    }))
  };

  // 读取现有数据并 prepend
  let existingData = [];
  if (fs.existsSync(DATA_PATH)) {
    existingData = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  }

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
