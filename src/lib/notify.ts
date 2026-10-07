import { LocalNotifications } from '@capacitor/local-notifications';
import { liveBlocks, missionFor, planFor, wakeVerified } from '../core/engine';
import type { Doc } from '../core/types';
import { addDays, clockOf, dayStartMs, fmtClock, logicalDate, MIN } from '../core/time';
import { isAndroid } from './platform';

// One notification API for three platforms:
// - Android: real OS notifications scheduled ahead of time (they fire even when the app is closed)
// - Windows app / browser: Web Notifications while the app is running (the Windows app keeps running in the tray)

const BLOCK_RANGE = [1000, 1999] as const;
const WAKE_RANGE = [2000, 2099] as const;
let channelsReady = false;

export async function notificationPermission(): Promise<'granted' | 'denied' | 'default'> {
  if (isAndroid) {
    const p = await LocalNotifications.checkPermissions();
    return p.display === 'granted' ? 'granted' : p.display === 'denied' ? 'denied' : 'default';
  }
  if (typeof Notification === 'undefined') return 'denied';
  return Notification.permission;
}

export async function requestNotifications(): Promise<boolean> {
  if (isAndroid) {
    const p = await LocalNotifications.requestPermissions();
    await ensureChannels();
    return p.display === 'granted';
  }
  if (typeof Notification === 'undefined') return false;
  const r = await Notification.requestPermission();
  return r === 'granted';
}

async function ensureChannels() {
  if (!isAndroid || channelsReady) return;
  await LocalNotifications.createChannel({
    id: 'eos-alarm',
    name: 'Wake alarm',
    description: 'The wake checkpoint alarm',
    importance: 5,
    visibility: 1,
    vibration: true,
    sound: 'eos_bell.wav',
  });
  await LocalNotifications.createChannel({
    id: 'eos-blocks',
    name: 'Block changes',
    description: 'When a new life block starts',
    importance: 4,
    visibility: 1,
    vibration: true,
  });
  channelsReady = true;
}

export async function notify(title: string, body: string) {
  try {
    if (isAndroid) {
      await ensureChannels();
      await LocalNotifications.schedule({
        notifications: [{ id: 3000 + Math.floor(Math.random() * 900), title, body, channelId: 'eos-blocks' }],
      });
      return;
    }
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(title, { body, icon: './icon-192.png', tag: 'eos-' + title });
    }
  } catch {
    /* notifications are best-effort */
  }
}

export async function exactAlarmStatus(): Promise<string | null> {
  if (!isAndroid) return null;
  try {
    const r = await LocalNotifications.checkExactNotificationSetting();
    return r.exact_alarm;
  } catch {
    return null;
  }
}

export async function openExactAlarmSettings() {
  if (!isAndroid) return;
  try {
    await LocalNotifications.changeExactNotificationSetting();
  } catch {
    /* older Android: nothing to change */
  }
}

let scheduleTimer: number | undefined;

/** Android only: (re)schedule the next 36 hours of block and wake notifications. Debounced. */
export function scheduleAhead(doc: Doc) {
  if (!isAndroid) return;
  window.clearTimeout(scheduleTimer);
  scheduleTimer = window.setTimeout(() => void doSchedule(doc), 2500);
}

async function doSchedule(doc: Doc) {
  try {
    const perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') return;
    await ensureChannels();
    const pending = await LocalNotifications.getPending();
    const ours = pending.notifications.filter((n) => n.id >= BLOCK_RANGE[0] && n.id <= WAKE_RANGE[1]);
    if (ours.length) await LocalNotifications.cancel({ notifications: ours.map((n) => ({ id: n.id })) });

    const now = Date.now();
    const horizon = now + 36 * 60 * MIN;
    const { settings } = doc;
    const today = logicalDate(now, settings.dayStart);
    const list: Parameters<typeof LocalNotifications.schedule>[0]['notifications'] = [];
    let blockId = BLOCK_RANGE[0];
    let wakeId = WAKE_RANGE[0];

    for (const date of [today, addDays(today, 1)]) {
      const plan = planFor(doc, date);
      const base = dayStartMs(date, settings.dayStart);
      if (settings.notifyBlocks) {
        for (const b of liveBlocks(plan)) {
          const at = base + b.s * MIN;
          if (at <= now + 5000 || at > horizon || blockId > BLOCK_RANGE[1]) continue;
          const mission = missionFor(plan, b)?.title;
          list.push({
            id: blockId++,
            title: b.title,
            body: `${mission ? mission + ' · ' : ''}until ${fmtClock(clockOf(b.e, settings.dayStart))}`,
            channelId: 'eos-blocks',
            schedule: { at: new Date(at), allowWhileIdle: true },
          });
        }
      }
      if (settings.wakeGate && !wakeVerified(doc, date)) {
        for (let k = 0; k <= 10; k++) {
          const at = base + k * 2 * MIN;
          if (at <= now || at > horizon) continue;
          list.push({
            id: wakeId++,
            title: k === 0 ? 'Wake checkpoint' : 'Still not verified',
            body: 'Scan your wake QR code to start the day.',
            channelId: 'eos-alarm',
            schedule: { at: new Date(at), allowWhileIdle: true },
            ongoing: false,
            autoCancel: true,
          });
        }
      }
    }
    if (list.length) await LocalNotifications.schedule({ notifications: list });
  } catch (err) {
    console.warn('Notification scheduling failed', err);
  }
}
