import _ from 'lodash';

import {db} from './database';
import {espnHandler} from './espn-handler';
import {foxHandler} from './fox-handler';
import {IHeaders} from './shared-interfaces';
import {ChunklistHandler} from './manifest-helpers';
import {nbcHandler} from './nbc-handler';
import {appStatus} from './app-status';

const checkingStream = {};

const startChannelStream = async (channelId: string, appUrl) => {
  if (appStatus.channels[channelId].player || checkingStream[channelId]) {
    return;
  }

  checkingStream[channelId] = true;

  let url;
  let headers: IHeaders;

  const playingNow: any = await db.entries.findOne({
    id: appStatus.channels[channelId].current,
  });

  if (!playingNow) {
    return;
  }

  if (playingNow.from === 'foxsports') {
    try {
      [url, headers] = await foxHandler.getEventData(appStatus.channels[channelId].current);
    } catch (e) {}
  } else if (playingNow.from === 'nbcsports') {
    try {
      [url, headers] = await nbcHandler.getEventData(playingNow);
    } catch (e) {}
  } else {
    try {
      [url, headers] = await espnHandler.getEventData(appStatus.channels[channelId].current);
    } catch (e) {}
  }

  checkingStream[channelId] = false;

  if (!url) {
    console.log('Failed to parse the stream');
    return;
  }

  try {
    appStatus.channels[channelId].player = new ChunklistHandler(url, headers, appUrl, channelId);
  } catch (e) {
    appStatus.channels[channelId].player = undefined;
  }
};

const delayedStart = async (channelId: string, appUrl: string): Promise<void> => {
  if (appStatus.channels[channelId].player) {
    try {
      appStatus.channels[channelId].player && appStatus.channels[channelId].player.stop();
      appStatus.channels[channelId].player = null;
    } catch (e) {}
  }
  appStatus.channels[channelId].current = appStatus.channels[channelId].nextUp;

  clearTimeout(appStatus.channels[channelId].nextUpTimer);
  appStatus.channels[channelId].nextUp = null;
  appStatus.channels[channelId].nextUpTimer = null;

  startChannelStream(channelId, appUrl);
};

export const launchChannel = _.throttle(
  async (channelId: string, appUrl: string): Promise<void> => {
    if (appStatus.channels[channelId].player || checkingStream[channelId]) {
      return;
    }

    const now = new Date().valueOf();
    const channel = parseInt(channelId, 10);
    const playingNow = await db.entries.findOne({
      channel,
      end: {$gt: now},
      start: {$lt: now},
    });

    if (playingNow && (playingNow as any).id) {
      console.log(`Channel #${channelId} has an active event. Going to start the stream.`);
      appStatus.channels[channelId].current = (playingNow as any).id;
      startChannelStream(channelId, appUrl);
    }
  },
  500,
  {leading: true, trailing: false},
);

export const checkNextStream = _.throttle(
  async (channelId: string, appUrl: string): Promise<void> => {
    const now = new Date().valueOf();

    if (appStatus.channels[channelId].nextUp || appStatus.channels[channelId].nextUpTimer) {
      return;
    }

    const channel = parseInt(channelId, 10);
    const entries = await db.entries.find({channel, start: {$gt: now}}).sort({start: 1});

    const now2 = new Date().valueOf();

    if (entries && entries.length > 0 && now - appStatus.channels[channelId].heartbeat < 30 * 1000) {
      const diff = (entries[0] as any).start - now2;

      console.log(`Channel #${channelId} has upcoming event. Setting timer to start`);

      appStatus.channels[channelId].nextUp = (entries[0] as any).id;
      appStatus.channels[channelId].nextUpTimer = setTimeout(() => delayedStart(channelId, appUrl), diff);
    }
  },
  500,
  {leading: true, trailing: false},
);
