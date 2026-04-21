import { S3Client } from "bun";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, relative, resolve } from "node:path";

import { z } from "zod";

import { probeDurationSeconds } from "./audio";

const PROJECT_ROOT = import.meta.dir;
const PODCAST_CONFIG_PATH = resolve(PROJECT_ROOT, "podcast.config.json");
const PODCAST_EPISODES_ROOT = resolve(PROJECT_ROOT, "podcast", "episodes");
const PODCAST_SITE_ROOT = resolve(PROJECT_ROOT, "podcast", "site");
const OUTPUT_DIRECTORY_PATTERN = /^(\d{2})-(\d{2})-(.+)$/u;
const AUDIO_FILE_SUFFIX = ".merge.offtopic.m4a";
const SHOWNOTES_FILE_SUFFIX = ".shownotes.txt";

const podcastConfigSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  language: z.string().min(1),
  author: z.string().min(1),
  ownerName: z.string().min(1),
  ownerEmail: z.string().email(),
  category: z.string().min(1),
  subcategory: z.string().min(1),
  explicit: z.boolean(),
  type: z.enum(["episodic", "serial"]),
  siteUrl: z.string().url(),
  defaultPublishTime: z
    .string()
    .regex(/^\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/u),
  coverImageSourcePath: z.string().min(1),
  coverImageOutputPath: z.string().min(1),
  copyright: z.string().min(1),
});

const episodeManifestSchema = z.object({
  id: z.string().min(1),
  guid: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  publishedAt: z.string().datetime({ offset: true }),
  seasonNumber: z.string().regex(/^\d{4}$/u),
  episodeNumber: z.string().regex(/^\d{4}$/u),
  audioUrl: z.string().url(),
  audioBytes: z.number().int().positive(),
  audioType: z.string().min(1),
  durationSeconds: z.number().positive(),
  source: z.object({
    outputDir: z.string().min(1),
    audioFileName: z.string().min(1),
    shownotesFileName: z.string().min(1),
    bvid: z.string().min(1),
    objectKey: z.string().min(1),
  }),
});

const podcastUploadEnvironmentSchema = z.object({
  PODCAST_R2_ACCOUNT_ID: z.string().min(1),
  PODCAST_R2_BEARER_TOKEN: z.string().min(1),
  PODCAST_R2_BUCKET: z.string().min(1),
  PODCAST_R2_PUBLIC_BASE_URL: z.string().url(),
});

type PodcastConfig = z.infer<typeof podcastConfigSchema>;
type EpisodeManifest = z.infer<typeof episodeManifestSchema>;
type PodcastUploadEnvironment = z.infer<typeof podcastUploadEnvironmentSchema>;

interface PodcastUploadCredentials extends PodcastUploadEnvironment {
  PODCAST_R2_ACCESS_KEY_ID: string;
  PODCAST_R2_SECRET_ACCESS_KEY: string;
}

interface SourceEpisode {
  id: string;
  guid: string;
  title: string;
  description: string;
  publishedAt: string;
  seasonNumber: string;
  episodeNumber: string;
  audioBytes: number;
  audioType: string;
  durationSeconds: number;
  source: EpisodeManifest["source"];
}

await main(process.argv.slice(2));

async function main(args: string[]): Promise<void> {
  const command = args[0];

  if (command === "stage") {
    const outputDirectory = args[1];
    if (outputDirectory === undefined) {
      throw new Error("Usage: bun run podcast.ts stage <output-directory>");
    }
    await stageEpisode(outputDirectory);
    return;
  }

  if (command === "build") {
    buildPodcastSite(loadPodcastConfig(), loadEpisodeManifests());
    return;
  }

  throw new Error("Usage: bun run podcast.ts <stage|build> ...");
}

async function stageEpisode(outputDirectory: string): Promise<void> {
  const config = loadPodcastConfig();
  const uploadEnvironment = await loadPodcastUploadEnvironment();
  const sourceEpisode = await readSourceEpisode(
    outputDirectory,
    config.defaultPublishTime,
  );
  const audioUrl = await uploadEpisodeAudio(sourceEpisode, uploadEnvironment);
  const episodeManifest = buildEpisodeManifest(sourceEpisode, audioUrl);
  writeEpisodeManifest(episodeManifest);
  buildPodcastSite(config, loadEpisodeManifests());
  console.log(`Staged ${episodeManifest.id}`);
}

function buildPodcastSite(
  config: PodcastConfig,
  episodeManifests: readonly EpisodeManifest[],
): void {
  const siteUrl = normalizeSiteUrl(config.siteUrl);
  const coverImageUrl = joinPublicUrl(siteUrl, config.coverImageOutputPath);
  const sortedEpisodeManifests = [...episodeManifests].sort((left, right) =>
    right.publishedAt.localeCompare(left.publishedAt),
  );
  const coverImageOutputDirectory = resolve(
    PODCAST_SITE_ROOT,
    dirname(config.coverImageOutputPath),
  );

  rmSync(PODCAST_SITE_ROOT, { recursive: true, force: true });
  mkdirSync(PODCAST_SITE_ROOT, { recursive: true });
  mkdirSync(coverImageOutputDirectory, { recursive: true });

  cpSync(
    resolve(PROJECT_ROOT, config.coverImageSourcePath),
    resolve(PODCAST_SITE_ROOT, config.coverImageOutputPath),
  );
  writeFileSync(
    resolve(PODCAST_SITE_ROOT, "feed.xml"),
    buildFeedXml(config, sortedEpisodeManifests, coverImageUrl),
  );
  writeFileSync(
    resolve(PODCAST_SITE_ROOT, "index.html"),
    buildSiteIndexHtml(config, sortedEpisodeManifests, coverImageUrl),
  );
}

function loadPodcastConfig(): PodcastConfig {
  if (!existsSync(PODCAST_CONFIG_PATH)) {
    throw new Error(
      `Missing podcast config: ${relative(PROJECT_ROOT, PODCAST_CONFIG_PATH)}`,
    );
  }

  return podcastConfigSchema.parse(
    JSON.parse(readFileSync(PODCAST_CONFIG_PATH, "utf8")),
  );
}

function loadEpisodeManifests(): EpisodeManifest[] {
  mkdirSync(PODCAST_EPISODES_ROOT, { recursive: true });

  return collectEpisodeManifestPaths(PODCAST_EPISODES_ROOT).map(
    (manifestPath) =>
      episodeManifestSchema.parse(
        JSON.parse(readFileSync(manifestPath, "utf8")),
      ),
  );
}

async function loadPodcastUploadEnvironment(): Promise<PodcastUploadCredentials> {
  const uploadEnvironment = podcastUploadEnvironmentSchema.parse(process.env);
  const verifyResponse = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${uploadEnvironment.PODCAST_R2_ACCOUNT_ID}/tokens/verify`,
    {
      headers: {
        Authorization: `Bearer ${uploadEnvironment.PODCAST_R2_BEARER_TOKEN}`,
      },
    },
  );

  if (!verifyResponse.ok) {
    throw new Error(
      `Failed to verify R2 bearer token: ${verifyResponse.status} ${verifyResponse.statusText}`,
    );
  }

  const verifyPayload = z
    .object({
      success: z.literal(true),
      result: z.object({
        id: z.string().length(32),
      }),
    })
    .parse(await verifyResponse.json());

  return {
    ...uploadEnvironment,
    PODCAST_R2_ACCESS_KEY_ID: verifyPayload.result.id,
    PODCAST_R2_SECRET_ACCESS_KEY: createHash("sha256")
      .update(uploadEnvironment.PODCAST_R2_BEARER_TOKEN)
      .digest("hex"),
  };
}

async function readSourceEpisode(
  outputDirectory: string,
  defaultPublishTime: string,
): Promise<SourceEpisode> {
  const resolvedOutputDirectory = resolve(PROJECT_ROOT, outputDirectory);
  const outputDirectoryName = basename(resolvedOutputDirectory);
  const outputYear = basename(resolve(resolvedOutputDirectory, ".."));
  const outputDirectoryMatch = outputDirectoryName.match(OUTPUT_DIRECTORY_PATTERN);

  if (outputDirectoryMatch === null) {
    throw new Error(`Invalid output directory name: ${outputDirectoryName}`);
  }
  if (!/^\d{4}$/u.test(outputYear)) {
    throw new Error(`Invalid episode year directory: ${outputYear}`);
  }

  const [, month, day, title] = outputDirectoryMatch;
  const audioFileName = readSingleFileName(resolvedOutputDirectory, AUDIO_FILE_SUFFIX);
  const shownotesFileName = readSingleFileName(
    resolvedOutputDirectory,
    SHOWNOTES_FILE_SUFFIX,
  );
  const audioPath = resolve(resolvedOutputDirectory, audioFileName);
  const shownotesPath = resolve(resolvedOutputDirectory, shownotesFileName);
  const bvid = audioFileName.slice(0, -AUDIO_FILE_SUFFIX.length);

  return {
    id: `${outputYear}-${month}${day}`,
    guid: `scboy:${outputYear}:${month}${day}:${bvid}`,
    title,
    description: readFileSync(shownotesPath, "utf8"),
    publishedAt: `${outputYear}-${month}-${day}T${defaultPublishTime}`,
    seasonNumber: outputYear,
    episodeNumber: `${month}${day}`,
    audioBytes: statSync(audioPath).size,
    audioType: inferAudioType(audioPath),
    durationSeconds: await probeDurationSeconds(audioPath),
    source: {
      outputDir: relative(PROJECT_ROOT, resolvedOutputDirectory),
      audioFileName,
      shownotesFileName,
      bvid,
      objectKey: `episodes/${outputYear}/${month}${day}-${bvid}${extname(audioPath)}`,
    },
  };
}

async function uploadEpisodeAudio(
  sourceEpisode: SourceEpisode,
  uploadEnvironment: PodcastUploadCredentials,
): Promise<string> {
  const audioPath = resolve(
    PROJECT_ROOT,
    sourceEpisode.source.outputDir,
    sourceEpisode.source.audioFileName,
  );
  const bucket = new S3Client({
    accessKeyId: uploadEnvironment.PODCAST_R2_ACCESS_KEY_ID,
    secretAccessKey: uploadEnvironment.PODCAST_R2_SECRET_ACCESS_KEY,
    bucket: uploadEnvironment.PODCAST_R2_BUCKET,
    endpoint: `https://${uploadEnvironment.PODCAST_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  });

  await bucket.write(sourceEpisode.source.objectKey, Bun.file(audioPath), {
    type: sourceEpisode.audioType,
  });

  return joinPublicUrl(
    uploadEnvironment.PODCAST_R2_PUBLIC_BASE_URL,
    sourceEpisode.source.objectKey,
  );
}

function buildEpisodeManifest(
  sourceEpisode: SourceEpisode,
  audioUrl: string,
): EpisodeManifest {
  return episodeManifestSchema.parse({
    ...sourceEpisode,
    audioUrl,
  });
}

function writeEpisodeManifest(episodeManifest: EpisodeManifest): void {
  const episodeDirectory = resolve(PODCAST_EPISODES_ROOT, episodeManifest.seasonNumber);
  mkdirSync(episodeDirectory, { recursive: true });
  writeFileSync(
    resolve(episodeDirectory, `${episodeManifest.episodeNumber}.json`),
    `${JSON.stringify(episodeManifest, null, 2)}\n`,
  );
}

function buildFeedXml(
  config: PodcastConfig,
  episodeManifests: readonly EpisodeManifest[],
  coverImageUrl: string,
): string {
  const siteUrl = normalizeSiteUrl(config.siteUrl);
  const feedUrl = joinPublicUrl(siteUrl, "feed.xml");
  const lastBuildDate =
    episodeManifests.length === 0
      ? new Date().toUTCString()
      : new Date(episodeManifests[0].publishedAt).toUTCString();
  const items = episodeManifests
    .map((episodeManifest) =>
      buildFeedItemXml(config, siteUrl, coverImageUrl, episodeManifest),
    )
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${xmlEscape(config.title)}</title>
    <link>${xmlEscape(siteUrl)}</link>
    <description>${xmlEscape(config.description)}</description>
    <language>${xmlEscape(config.language)}</language>
    <copyright>${xmlEscape(config.copyright)}</copyright>
    <lastBuildDate>${xmlEscape(lastBuildDate)}</lastBuildDate>
    <atom:link href="${xmlEscape(feedUrl)}" rel="self" type="application/rss+xml" />
    <itunes:type>${xmlEscape(config.type)}</itunes:type>
    <itunes:author>${xmlEscape(config.author)}</itunes:author>
    <itunes:summary>${xmlEscape(config.description)}</itunes:summary>
    <itunes:subtitle>${xmlEscape(config.description)}</itunes:subtitle>
    <itunes:explicit>${config.explicit ? "true" : "false"}</itunes:explicit>
    <itunes:owner>
      <itunes:name>${xmlEscape(config.ownerName)}</itunes:name>
      <itunes:email>${xmlEscape(config.ownerEmail)}</itunes:email>
    </itunes:owner>
    <itunes:image href="${xmlEscape(coverImageUrl)}" />
    <itunes:category text="${xmlEscape(config.category)}">
      <itunes:category text="${xmlEscape(config.subcategory)}" />
    </itunes:category>
${items}  </channel>
</rss>
`;
}

function buildSiteIndexHtml(
  config: PodcastConfig,
  episodeManifests: readonly EpisodeManifest[],
  coverImageUrl: string,
): string {
  const feedUrl = joinPublicUrl(config.siteUrl, "feed.xml");
  const episodeItems = episodeManifests
    .map(
      (episodeManifest) => `        <article id="${episodeManifest.id}">
          <h2>${htmlEscape(episodeManifest.title)}</h2>
          <p>${htmlEscape(episodeManifest.publishedAt.slice(0, 10))} · S${htmlEscape(episodeManifest.seasonNumber)} · E${htmlEscape(episodeManifest.episodeNumber)}</p>
          <p><a href="${htmlEscape(episodeManifest.audioUrl)}">音频</a></p>
          <pre>${htmlEscape(episodeManifest.description)}</pre>
        </article>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${htmlEscape(config.title)}</title>
    <style>
      :root {
        color-scheme: light;
        font-family: "PingFang SC", "Noto Sans SC", sans-serif;
        background: #f5efe4;
        color: #1d1d1f;
      }
      body {
        margin: 0 auto;
        max-width: 860px;
        padding: 40px 20px 96px;
        line-height: 1.6;
      }
      img {
        width: 160px;
        border-radius: 24px;
      }
      a {
        color: #0a58ca;
      }
      article {
        padding: 24px 0;
        border-top: 1px solid #d7cfbf;
      }
      pre {
        white-space: pre-wrap;
        font: inherit;
      }
    </style>
  </head>
  <body>
    <header>
      <img src="${htmlEscape(coverImageUrl)}" alt="${htmlEscape(config.title)}" />
      <h1>${htmlEscape(config.title)}</h1>
      <p>${htmlEscape(config.description)}</p>
      <p><a href="${htmlEscape(feedUrl)}">RSS Feed</a></p>
    </header>
    <main>
${episodeItems}
    </main>
  </body>
</html>
`;
}

function buildFeedItemXml(
  config: PodcastConfig,
  siteUrl: string,
  coverImageUrl: string,
  episodeManifest: EpisodeManifest,
): string {
  return `    <item>
      <title>${xmlEscape(episodeManifest.title)}</title>
      <link>${xmlEscape(`${siteUrl}/#${episodeManifest.id}`)}</link>
      <guid isPermaLink="false">${xmlEscape(episodeManifest.guid)}</guid>
      <description>${xmlEscape(episodeManifest.description)}</description>
      <content:encoded><![CDATA[${episodeManifest.description}]]></content:encoded>
      <pubDate>${xmlEscape(new Date(episodeManifest.publishedAt).toUTCString())}</pubDate>
      <enclosure url="${xmlEscape(episodeManifest.audioUrl)}" length="${episodeManifest.audioBytes}" type="${xmlEscape(episodeManifest.audioType)}" />
      <itunes:title>${xmlEscape(episodeManifest.title)}</itunes:title>
      <itunes:author>${xmlEscape(config.author)}</itunes:author>
      <itunes:summary>${xmlEscape(episodeManifest.description)}</itunes:summary>
      <itunes:subtitle>${xmlEscape(episodeManifest.title)}</itunes:subtitle>
      <itunes:explicit>${config.explicit ? "true" : "false"}</itunes:explicit>
      <itunes:image href="${xmlEscape(coverImageUrl)}" />
      <itunes:duration>${xmlEscape(formatDuration(episodeManifest.durationSeconds))}</itunes:duration>
      <itunes:season>${xmlEscape(episodeManifest.seasonNumber)}</itunes:season>
      <itunes:episode>${xmlEscape(episodeManifest.episodeNumber)}</itunes:episode>
      <itunes:episodeType>full</itunes:episodeType>
    </item>
`;
}

function collectEpisodeManifestPaths(rootDirectory: string): string[] {
  const entries = readdirSync(rootDirectory, { withFileTypes: true });
  const manifestPaths: string[] = [];

  for (const entry of entries) {
    const entryPath = resolve(rootDirectory, entry.name);
    if (entry.isDirectory()) {
      manifestPaths.push(...collectEpisodeManifestPaths(entryPath));
      continue;
    }
    if (entry.isFile() && entryPath.endsWith(".json")) {
      manifestPaths.push(entryPath);
    }
  }

  return manifestPaths.sort((left, right) => left.localeCompare(right));
}

function readSingleFileName(directoryPath: string, suffix: string): string {
  const matches = readdirSync(directoryPath).filter((entry) => entry.endsWith(suffix));

  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${suffix} file in ${relative(PROJECT_ROOT, directoryPath)}`,
    );
  }

  return matches[0];
}

function inferAudioType(audioPath: string): string {
  const extension = extname(audioPath).toLowerCase();

  if (extension === ".m4a") {
    return "audio/mp4";
  }
  if (extension === ".mp3") {
    return "audio/mpeg";
  }

  throw new Error(`Unsupported audio extension: ${extension}`);
}

function normalizeSiteUrl(siteUrl: string): string {
  return siteUrl.endsWith("/") ? siteUrl.slice(0, -1) : siteUrl;
}

function joinPublicUrl(baseUrl: string, path: string): string {
  return `${normalizeSiteUrl(baseUrl)}/${path.replace(/^\/+/u, "")}`;
}

function formatDuration(durationSeconds: number): string {
  const totalSeconds = Math.floor(durationSeconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function htmlEscape(value: string): string {
  return xmlEscape(value);
}
