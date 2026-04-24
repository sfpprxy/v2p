import { Client } from "@renmu/bili-api";

export interface BiliVideoApiItem {
  title: string;
  length: string;
  bvid: string;
  created: number;
}

interface RawBiliVideoPart {
  cid: number;
  page: number;
  part: string;
  duration: number;
}

export class BiliVideoPart {
  constructor(
    public readonly bvid: string,
    public readonly cid: number,
    public readonly page: number,
    public readonly tittle: string,
    public readonly duration: number,
  ) {}
}

export class BiliVideo {
  constructor(
    public readonly title: string,
    public readonly length: string,
    public readonly bvid: string,
    public readonly uploadAt: Date,
  ) {}

  static fromDbRow(row: Record<string, unknown>): BiliVideo {
    return new BiliVideo(
      String(row.title),
      String(row.length),
      String(row.bvid),
      new Date(String(row.upload_at)),
    );
  }

  static fromApiItem(item: BiliVideoApiItem): BiliVideo {
    return new BiliVideo(
      item.title,
      item.length,
      item.bvid,
      new Date(item.created * 1000),
    );
  }

  async getParts(client: Client): Promise<BiliVideoPart[]> {
    const pages = (await client.video.pagelist({
      bvid: this.bvid,
    })) as unknown as RawBiliVideoPart[];

    return pages.map(
      (page) =>
        new BiliVideoPart(
          this.bvid,
          page.cid,
          page.page,
          page.part,
          page.duration,
        ),
    );
  }
}
