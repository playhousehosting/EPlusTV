import axios from 'axios';
import {Chunklist, Playlist, RenditionSortOrder} from 'dynamic-hls-proxy';
import _ from 'lodash';

import {userAgent} from './user-agent';
import {IHeaders} from './shared-interfaces';
import {cacheLayer} from './cache-layer';

const isRelativeUrl = (url: string): boolean =>
  url.startsWith('http') ? false : true;
const cleanUrl = (url: string): string =>
  url.replace(/(\[.*\])/gm, '').replace(/(?<!:)\/\//gm, '/');
const createBaseUrl = (url: string): string => {
  const cleaned = url.replace(/\.m3u8.*$/, '');
  return cleaned.substring(0, cleaned.lastIndexOf('/') + 1);
};

const VALID_RESOLUTIONS = ['UHD/HDR', 'UHD/SDR', '1080p', '720p', '540p'];

const getMaxRes = _.memoize((): string =>
  _.includes(VALID_RESOLUTIONS, process.env.MAX_RESOLUTION)
    ? process.env.MAX_RESOLUTION
    : 'UHD/SDR',
);

const getResolutionRanges = _.memoize((): [number, number] => {
  const setProfile = getMaxRes();

  switch (setProfile) {
    case 'UHD/HDR':
    case 'UHD/SDR':
      return [0, 2160];
    case '1080p':
      return [0, 1080];
    case '720p':
      return [0, 720];
    default:
      return [0, 540];
  }
});

const reTarget = /#EXT-X-TARGETDURATION:([0-9]+)/;

const getTargetDuration = (chunklist: string): number => {
  let targetDuration = 2;

  const tester = reTarget.exec(chunklist);

  if (tester && tester[1]) {
    targetDuration = Math.floor(parseInt(tester[1], 10) / 2);

    if (!_.isNumber(targetDuration)) {
      targetDuration = 2;
    }
  }

  return targetDuration;
};

export class ChunklistHandler {
  public m3u8: string;

  private baseUrl: string;
  private baseManifestUrl: string;
  private headers: IHeaders;
  private channel: string;

  private interval: NodeJS.Timer;

  constructor(
    manifestUrl: string,
    headers: IHeaders,
    appUrl: string,
    channel: string,
  ) {
    this.headers = headers;
    this.channel = channel;

    this.baseUrl = `${appUrl}/channels/${channel}/`;

    (async () => {
      const chunkListUrl = await this.getChunklist(manifestUrl, this.headers);

      const fullChunkUrl = cleanUrl(
        isRelativeUrl(chunkListUrl)
          ? `${createBaseUrl(manifestUrl)}/${chunkListUrl}`
          : chunkListUrl,
      );
      this.baseManifestUrl = cleanUrl(createBaseUrl(fullChunkUrl));

      this.proxyChunklist(fullChunkUrl);
    })();
  }

  public async getSegmentOrKey(segmentId: string): Promise<ArrayBuffer> {
    try {
      return cacheLayer.getDataFromSegment(segmentId, this.headers);
    } catch (e) {
      console.error(e);
    }
  }

  public stop(): void {
    this.interval && clearInterval(this.interval);
  }

  private async getChunklist(
    manifestUrl: string,
    headers: IHeaders,
  ): Promise<string> {
    const [hMin, hMax] = getResolutionRanges();

    try {
      const {data: manifest} = await axios.get(manifestUrl, {
        headers: {
          'User-Agent': userAgent,
          ...headers,
        },
      });

      const playlist = Playlist.loadFromString(manifest);

      playlist.setResolutionRange(hMin, hMax);

      playlist
        .sortByBandwidth(
          getMaxRes() === '540p'
            ? RenditionSortOrder.nonHdFirst
            : RenditionSortOrder.bestFirst,
        )
        .setLimit(1);

      return playlist.getVideoRenditionUrl(0);
    } catch (e) {
      console.error(e);
      console.log('Could not parse M3U8 properly!');
    }
  }

  private async proxyChunklist(chunkListUrl: string): Promise<void> {
    try {
      const {data: chunkList} = await axios.get(chunkListUrl, {
        headers: {
          'User-Agent': userAgent,
          ...this.headers,
        },
      });

      if (!this.interval) {
        this.interval = setInterval(
          () => this.proxyChunklist(chunkListUrl),
          getTargetDuration(chunkList) * 1000,
        );
      }

      let updatedChunkList = chunkList;
      const keys = new Set<string>();
      const chunks = Chunklist.loadFromString(chunkList);

      chunks.segments.forEach(segment => {
        const fullSegmentUrl = isRelativeUrl(segment.segment.uri)
          ? `${this.baseManifestUrl}${segment.segment.uri}`
          : segment.segment.uri;
        const segmentName = cacheLayer.getSegmentFromUrl(
          fullSegmentUrl,
          `${this.channel}-segment`,
        );

        updatedChunkList = updatedChunkList.replace(
          segment.segment.uri,
          `${this.channel}/${segmentName}.ts`,
        );

        if (segment.segment.key) {
          keys.add(segment.segment.key.uri);
        }
      });

      keys.forEach(key => {
        const keyName = cacheLayer.getSegmentFromUrl(
          key,
          `${this.channel}-key`,
        );

        while (updatedChunkList.indexOf(key) > -1) {
          updatedChunkList = updatedChunkList.replace(
            key,
            `${this.baseUrl}${keyName}.key`,
          );
        }
      });

      process.nextTick(() => (this.m3u8 = updatedChunkList));
    } catch (e) {
      console.error(e);
      console.log('Could not parse chunklist properly!');
    }
  }
}
