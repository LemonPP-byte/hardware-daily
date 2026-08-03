# ⚡ 科技资讯 — 每日硬件新品速递

每日自动抓取海外硬件资讯，AI 筛选 7 条最值得关注的内容，面向图拉斯（Torras）
产品经理视角：充电类、3C 配件、智能硬件、AI 硬件。

线上：https://lemonpp-byte.github.io/hardware-daily/

## 架构

```
信息源 (RSS/API) → fetch-sources.js → DeepSeek 筛选 → data.json → 静态前端
```

## 信息源

**RSS（11 个）**

| 源 | 定位 |
|---|---|
| TechCrunch Hardware / The Verge / Wired / Engadget | 综合科技 |
| 9to5Mac | Apple 生态 |
| GSMArena / Android Authority | 手机与配件 |
| Dezeen / Core77 / Yanko Design | 工业设计 |
| Product Hunt | 新品发布 |

**API / 社区**

- Hacker News — 官方 API 取 top 50，按硬件关键词或 >200 分热度筛
- Reddit r/hardware、r/gadgets、r/singularity

已知问题：Reddit 的 r/gadgets 和 r/singularity 在 GitHub 机房 IP 上长期
返回 429，需要走 OAuth API 才能稳定获取。ChargerLAB 的 RSS 已下线。

## 内容策略

- 候选窗口 7 天，不要求当天新闻；质量与品类相关度优先于时效
- HN 高热度内容不受窗口限制，但会过滤纯软件/开发向内容
- 按 URL 去重，回看最近 5 天避免重复推送
- 分四层：每日头条 / 成熟品牌 / AI 硬件 / 新锐产品
- 宁缺勿滥：某一层没有合格内容时少返回，不用不相关内容凑数
- AI 返回的 URL 必须命中候选池，否则修正或丢弃（防止编造链接和来源）

## 本地运行

```bash
npm install
node scripts/fetch-sources.js                        # 抓取，产出 raw-feed.json
DEEPSEEK_API_KEY=sk-xxx node scripts/curate.js       # AI 筛选，写入 data.json
python3 -m http.server 8080                          # 查看页面
```

可选环境变量：`WINDOW_DAYS`（候选窗口天数，默认 7）

## 部署

1. Push 到 GitHub
2. repo Settings → Secrets 添加 `DEEPSEEK_API_KEY`
3. 开启 GitHub Pages（source: main branch, root）
4. Actions 自动更新：
   - 主跑 cron `43 22 * * *` = 北京时间 06:43 触发，数据 7 点前后落地
   - 兜底 cron `17 1 * * *` = 北京时间 09:17，仅当天数据缺失时执行

GitHub Actions 的排队延迟不可控，实测整点触发会晚 48-54 分钟，所以刻意
避开整点和半点。job 限时 20 分钟，卡住即失败而不是耗满 6 小时上限。

## 手动触发

Actions → Daily Hardware Feed Update → Run workflow

或 `gh workflow run daily-update.yml`
