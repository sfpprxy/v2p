# Podcast Automation

这个目录承载播客发布的 GitHub 控制面：

- `episodes/<year>/<episode>.json`
  本地把 `output/` 里的单集上传到 Cloudflare R2 之后，会在这里写入单集 manifest。
- `site/`
  GitHub Pages 发布产物目录。这个目录是生成物，不进版本库。

日常发布入口：

- 在本地运行 `bun run workflow.ts`
- 等待 GitHub Actions 重建并发布 `feed.xml`

`workflow.ts` 会在视频处理成功后根据业务层给出的单集编号，把本次生成的
`output/` 单集目录交给 `podcast:stage` 的内部逻辑。发布层会先读取对应的
`podcast/episodes/<year>/<episode-number>.json`，用本地音频、shownotes、标题、
发布时间、大小、时长和 R2 object key 重建预期 manifest；如果和已有 manifest
一致，就跳过 R2 上传和 manifest 写入。只有新增或发生差异的单集会重新上传音频并
更新 manifest。
随后 `workflow.ts` 会自动暂存 `podcast/episodes`，有发布差异时提交
`Publish podcast episodes`，并把当前分支推送到 upstream。推送后，GitHub Actions
会基于已提交的 manifest 重建并发布 feed。

本地发布依赖的 R2 环境变量现在只有：

- `PODCAST_R2_ACCOUNT_ID`
- `PODCAST_R2_BEARER_TOKEN`
- `PODCAST_R2_BUCKET`
- `PODCAST_R2_PUBLIC_BASE_URL`

`podcast:stage` 会在运行时用 `PODCAST_R2_BEARER_TOKEN` 调 Cloudflare token verify 接口取回 token id，并按 Cloudflare R2 文档推导出 S3 所需的 `Access Key ID / Secret Access Key`，所以 `.env` 不再保存这两个派生值。
`podcast.config.json` 里的 `guidPrefix` 是 RSS item GUID 的频道级前缀；发布脚本不会把具体频道名写死在代码里。

命令职责分工：

- `bun run podcast:stage -- <episode-number> <output-dir>`
  这是“发布一集”的手动入口。`episode-number` 由调用方显式提供，例如 `0311-1`。
  它会读取 `output/` 里的音频和 shownotes，检测 manifest 是否有差异；有差异才上传
  音频到 R2、写入 `podcast/episodes/<year>/<episode-number>.json`，最后重建一次本地
  `feed.xml`。
- `bun run podcast:build`
  这是“纯重建 feed”的入口。它不会读取 `output/`，也不会上传 R2，只会基于仓库里已有的 `podcast/episodes/**/*.json` 重建 `podcast/site/feed.xml` 和 `index.html`。

什么情况下只需要 `podcast:build`：

- 你修改了 `podcast.config.json`，比如频道标题、描述、作者、封面、分类。
- 你调整了 feed 生成逻辑或站点模板，但不需要重传音频。
- 你手动修正了某一集的 manifest，例如 `title`、`description`、`publishedAt`、`audioUrl`。
- GitHub Actions 在部署 Pages 时。CI 不读取你本地 `output/`，也不负责上传音频，只负责根据已提交的 manifest 重建 feed。

RSS 地址固定为：

- `https://sfpprxy.github.io/v2p/feed.xml`
