# Podcast Automation

这个目录承载播客发布的 GitHub 控制面：

- `episodes/<year>/<episode>.json`
  本地把 `output/` 里的单集上传到 Cloudflare R2 之后，会在这里写入单集 manifest。
- `site/`
  GitHub Pages 发布产物目录。这个目录是生成物，不进版本库。

发布路径固定为两步：

1. 在本地运行 `bun run podcast:stage -- <output-dir>`
2. 推送到 GitHub，让 Actions 重建并发布 `feed.xml`

本地发布依赖的 R2 环境变量现在只有：

- `PODCAST_R2_ACCOUNT_ID`
- `PODCAST_R2_BEARER_TOKEN`
- `PODCAST_R2_BUCKET`
- `PODCAST_R2_PUBLIC_BASE_URL`

`podcast:stage` 会在运行时用 `PODCAST_R2_BEARER_TOKEN` 调 Cloudflare token verify 接口取回 token id，并按 Cloudflare R2 文档推导出 S3 所需的 `Access Key ID / Secret Access Key`，所以 `.env` 不再保存这两个派生值。

命令职责分工：

- `bun run podcast:stage -- <output-dir>`
  这是“发布一集”的本地入口。它会读取 `output/` 里的音频和 shownotes，上传音频到 R2，写入 `podcast/episodes/<year>/<episode>.json`，然后重建一次本地 `feed.xml`。
- `bun run podcast:build`
  这是“纯重建 feed”的入口。它不会读取 `output/`，也不会上传 R2，只会基于仓库里已有的 `podcast/episodes/**/*.json` 重建 `podcast/site/feed.xml` 和 `index.html`。

什么情况下只需要 `podcast:build`：

- 你修改了 `podcast.config.json`，比如频道标题、描述、作者、封面、分类。
- 你调整了 feed 生成逻辑或站点模板，但不需要重传音频。
- 你手动修正了某一集的 manifest，例如 `title`、`description`、`publishedAt`、`audioUrl`。
- GitHub Actions 在部署 Pages 时。CI 不读取你本地 `output/`，也不负责上传音频，只负责根据已提交的 manifest 重建 feed。

RSS 地址固定为：

- `https://sfpprxy.github.io/v2p/feed.xml`
