# ⚡ 硬件日报

每日自动抓取海外硬件创新资讯，AI 筛选 3 条最值得关注的内容。

## 架构

```
信息源 (RSS/API) → 抓取脚本 → Claude AI 筛选 → data.json → 静态前端
```

## 信息源

- Product Hunt / Hacker News / Reddit
- Kickstarter / Indiegogo
- TechCrunch / The Verge / Wired
- Dezeen / Core77

## 本地运行

```bash
npm install
node scripts/fetch-sources.js    # 抓取
ANTHROPIC_API_KEY=sk-xxx node scripts/curate.js  # AI 筛选
python3 -m http.server 8080      # 查看页面
```

## 部署

1. Push 到 GitHub
2. 在 repo Settings → Secrets 添加 `ANTHROPIC_API_KEY`
3. 开启 GitHub Pages (source: main branch, root)
4. GitHub Actions 每天 UTC 23:00 (北京时间早 7 点) 自动更新

## 手动触发

Actions → Daily Hardware Feed Update → Run workflow
