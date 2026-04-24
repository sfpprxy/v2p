# 本项目内的播客发布方案

## 固定数据来源

脚本直接吃现有 `output/` 产物，不走 GUI 自动化：

- 音频：`output/<year>/<MM-DD-title>/*.merge.offtopic.m4a`
- 简介：`output/<year>/<MM-DD-title>/*.shownotes.txt`

目录名规则直接决定 RSS 元数据：

- `季度编号 = year`
- `单集编号 = 调用方传入的 MMDD-N`
- `标题 = 目录名去掉前缀 MM-DD-`

例如：

- `output/2026/02-11-2月11号帕鲁杯宝可梦DOTA2`
  会被解析成：
- `title = 2月11号帕鲁杯宝可梦DOTA2`
- `seasonNumber = 2026`
- `episodeNumber = 0211-1`

## 运行方式

先准备两类配置：

1. `podcast.config.json`
   由 `podcast.config.example.json` 改出正式值，主要是频道级元数据。
   其中 `guidPrefix` 用于生成 RSS item GUID。
2. `.env`
   填 R2 连接信息：
   - `PODCAST_R2_ACCOUNT_ID`
   - `PODCAST_R2_BEARER_TOKEN`
   - `PODCAST_R2_BUCKET`
   - `PODCAST_R2_PUBLIC_BASE_URL`

`PODCAST_R2_BEARER_TOKEN` 是 Cloudflare 创建 token 后给你的 bearer token。脚本会在运行时调用 Cloudflare 的 token verify 接口拿到 token id，并按官方文档把 bearer token 的 SHA-256 作为 S3 `Secret Access Key`，所以不再单独保存 `Access Key ID / Secret Access Key`。

发布一集：

```bash
bun run podcast:stage -- 0211-1 output/2026/02-11-2月11号帕鲁杯宝可梦DOTA2
```

这个命令会做三件事：

1. 上传音频到 R2
2. 在 `podcast/episodes/2026/0211-1.json` 写入 manifest
3. 在 `podcast/site/` 重建 `feed.xml` 和 `index.html`

然后把变更推上 GitHub。GitHub Actions 会重新构建并发布 Pages：

- RSS: `https://sfpprxy.github.io/v2p/feed.xml`

## Spotify 迁移

如果你现在是在 Spotify for Creators 托管原播客，等 Pages 发布成功后，在 Spotify 的“重定向你的播客”页面填写：

- `https://sfpprxy.github.io/v2p/feed.xml`

之后 Spotify 会永久把旧 feed 重定向到这个新 RSS。

## 为什么这样拆

- R2 负责音频分发：公网下行免费，适合播客文件。
- GitHub 负责 feed 和版本历史：每次发节目都会留下 manifest 变更。
- GitHub Pages 只托管轻量静态文件：`feed.xml`、封面、节目索引页。
