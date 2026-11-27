import { browser } from 'wxt/browser';
import {
  buildSeedUrl, isTestPinCookie, pendingKey, recordsKey, testPinCookieName, testPinUrl,
  type AttemptStatus, type CurrentPin, type PendingSwitch, type PinCommand,
  type PinRecord, type PinReply, type PinSnapshot,
} from '../lib/pins';

/** 当前切换关联的 Chrome 闹钟 */
const deadlineAlarm = 'pin-switch-deadline';

/** 网关加载及测试身份写入的最长等待时间 */
const switchTimeout = 30_000;

/** 本地存储中的记录格式版本 */
const schemaVersion = 1;

/** 可向面板展示的业务错误 */
class PinOperationError extends Error {}

/** 在本地记录中查找或新增指定 PIN */
function recordFor(records: PinRecord[], pin: string): PinRecord {
  // 已存在记录继续沿用其备注、收藏和确认时间。
  const existing = records.find((record) => record.pin === pin);
  if (existing) return existing;

  // 一次首次操作也需要在列表中留下记录。
  const record = { pin, note: '', favorite: false };
  records.push(record);
  return record;
}

/** 加载本地记录表 */
async function readRecords(): Promise<PinRecord[]> {
  // 记录表与当前网关 Cookie 分开存放。
  const stored = (await browser.storage.local.get(recordsKey))[recordsKey] as { version?: number; records?: PinRecord[] } | undefined;
  return stored?.version === schemaVersion && Array.isArray(stored.records) ? stored.records : [];
}

/** 持久化更新后的本地记录表 */
async function writeRecords(records: PinRecord[]): Promise<void> {
  await browser.storage.local.set({ [recordsKey]: { version: schemaVersion, records } });
}

/** 读取 Worker 与面板共享的进行中操作 */
async function readPending(): Promise<PendingSwitch | undefined> {
  return (await browser.storage.session.get(pendingKey))[pendingKey] as PendingSwitch | undefined;
}

/** 读取测试网关范围内的指定身份，不读取其他 Cookie */
async function readCurrent(): Promise<CurrentPin> {
  try {
    // 默认浏览器存储区与本插件的非无痕运行模式一致。
    const cookie = await browser.cookies.get({ name: testPinCookieName, url: testPinUrl });
    if (!cookie?.value) return { status: 'missing' };

    try {
      return { status: 'verified', pin: decodeURIComponent(cookie.value) };
    } catch {
      return { status: 'verified', pin: cookie.value };
    }
  } catch {
    return { status: 'unavailable' };
  }
}

/** 刷新发起种 PIN 时的页面，用户切走或关闭页面时跳过 */
async function reloadOriginTab(tabId: number): Promise<'requested' | 'skipped'> {
  try {
    // 刷新固定标签页，避免在异步确认后误刷刚切换到的页面。
    const tab = await browser.tabs.get(tabId);
    if (!tab.active) return 'skipped';
    await browser.tabs.reload(tabId);
    return 'requested';
  } catch {
    return 'skipped';
  }
}

/** 将操作结果落盘，然后释放当前切换占用 */
async function finishSwitch(operation: PendingSwitch, status: Exclude<AttemptStatus, 'pending'>): Promise<void> {
  // 只处理同一个操作，避免旧事件覆盖新的请求。
  const pending = await readPending();
  if (pending?.id !== operation.id) return;

  // 在最新记录上合并确认结果，保留期间修改的备注和收藏。
  const records = await readRecords();
  const record = recordFor(records, operation.pin);
  if (record.lastAttempt?.id !== operation.id || record.lastAttempt.status === 'pending') {
    record.lastAttempt = { id: operation.id, startedAt: operation.startedAt, status };
    if (status === 'confirmed') {
      record.lastUsedAt = Date.now();
      if (operation.refreshTabId !== undefined) {
        record.lastAttempt.pageReload = await reloadOriginTab(operation.refreshTabId);
      }
    }
    await writeRecords(records);
  }
  await browser.storage.session.remove(pendingKey);
  await browser.alarms.clear(deadlineAlarm);
}

/** 根据当前浏览器身份和截止时间处理未完成的切换 */
async function reconcileSwitch(): Promise<void> {
  // 会话数据在浏览器重启时消失，将遗留的待确认记录转换为可重试状态。
  const pending = await readPending();
  if (!pending) {
    // 当前只有本地记录，检查是否存在之前被中断的尝试。
    const records = await readRecords();
    const interrupted = records.filter((record) => record.lastAttempt?.status === 'pending');
    if (interrupted.length) {
      for (const record of interrupted) {
        if (record.lastAttempt) record.lastAttempt.status = 'unconfirmed';
      }
      await writeRecords(records);
    }
    return;
  }

  if (Date.now() >= pending.deadline) {
    await finishSwitch(pending, 'unconfirmed');
    return;
  }

  if (pending.responseReceived) {
    // 本次网关请求成功返回后，才根据当前 Cookie 确认切换。
    const current = await readCurrent();
    if (current.status === 'verified' && current.pin === pending.pin) {
      await finishSwitch(pending, 'confirmed');
    }
  }
}

/** 生成一份可发送到侧边栏的实时状态 */
async function snapshot(): Promise<PinSnapshot> {
  // 串行队列保证快照对应同一次后台更新。
  const [current, records, pending] = await Promise.all([readCurrent(), readRecords(), readPending()]);
  return { current, records, pending };
}

/** 保存待确认状态，为后台网关请求预留一次操作 */
async function prepareSwitch(pin: string, refreshTabId?: number): Promise<PendingSwitch> {
  await reconcileSwitch();
  if (await readPending()) throw new PinOperationError('有一个 PIN 正在切换，请等待结果。');

  // 先保存操作意图，确保面板关闭或 Worker 重启时还能恢复。
  const startedAt = Date.now();
  const operation: PendingSwitch = { id: crypto.randomUUID(), pin, startedAt, deadline: startedAt + switchTimeout };
  if (refreshTabId !== undefined) operation.refreshTabId = refreshTabId;
  await browser.storage.session.set({ [pendingKey]: operation });

  try {
    // 待确认状态需要独立于侧边栏存活。
    const records = await readRecords();
    recordFor(records, pin).lastAttempt = { id: operation.id, startedAt, status: 'pending' };
    await writeRecords(records);
    await browser.alarms.create(deadlineAlarm, { when: operation.deadline });
    return operation;
  } catch {
    await finishSwitch(operation, 'failed');
    throw new PinOperationError('无法发起种 PIN，请在记录中重试。');
  }
}

/** 请求已配置的测试网关，让 Chrome 正常接收测试身份 Cookie */
async function requestSeed(operation: PendingSwitch): Promise<boolean> {
  // 保留浏览器凭据处理，并避免复用缓存的种 PIN 响应。
  const response = await fetch(buildSeedUrl(operation.pin), {
    credentials: 'include',
    cache: 'no-store',
    signal: AbortSignal.timeout(Math.max(1, operation.deadline - Date.now())),
  });
  return response.ok;
}

/** 合并网关响应并复核本次切换，过期操作不能更新记录 */
async function settleSeedResponse(operation: PendingSwitch, accepted: boolean): Promise<void> {
  // 串行更新依旧以当前还在等待的操作为准。
  const pending = await readPending();
  if (pending?.id !== operation.id) return;

  if (Date.now() >= pending.deadline) {
    await finishSwitch(pending, 'unconfirmed');
  } else if (!accepted) {
    await finishSwitch(pending, 'failed');
  } else {
    await browser.storage.session.set({ [pendingKey]: { ...pending, responseReceived: true } });
    await reconcileSwitch();
  }
}

/** 处理侧边栏命令并返回最新状态 */
async function handleCommand(command: PinCommand, launchSeed: (operation: PendingSwitch) => void): Promise<PinReply> {
  if (command.type === 'snapshot') {
    await reconcileSwitch();
    return { snapshot: await snapshot() };
  }

  // 仅去除首尾空白，保留大小写和前导零。
  const pin = command.pin.trim();
  if (!pin) throw new PinOperationError('请输入测试 PIN。');

  if (command.type === 'switch') {
    launchSeed(await prepareSwitch(pin, command.refreshTabId));
  } else {
    // 备注与收藏在同一条记录上更新。
    const records = await readRecords();
    const record = recordFor(records, pin);
    if (command.type === 'save') record.note = command.note.trim().slice(0, 80);
    if (command.type === 'favorite') record.favorite = !record.favorite;
    await writeRecords(records);
  }

  return { snapshot: await snapshot() };
}

/** 注册侧边栏动作、串行操作队列与后台确认事件 */
export default defineBackground(() => {
  // 所有本地读改写和核验事件走同一队列，多个窗口共用一次切换。
  let queue: Promise<unknown> = Promise.resolve();

  // 抛错的任务不能阻塞后续操作。
  const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
    // 对外保留当前任务的结果，内部队列始终可继续。
    const result = queue.then(run);
    queue = result.catch(() => undefined);
    return result;
  };

  // 网关请求在队列外等待，侧边栏仍能查看记录和保存备注。
  const launchSeed = (operation: PendingSwitch): void => {
    void requestSeed(operation).catch(() => false)
      .then((accepted) => enqueue(() => settleSeedResponse(operation, accepted)))
      .catch(() => undefined);
  };

  // 安装后点击工具栏图标直接打开侧边栏。
  browser.runtime.onInstalled.addListener(() => {
    void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  });

  // 浏览器重启后收敛上次中断的操作。
  browser.runtime.onStartup.addListener(() => {
    void enqueue(() => reconcileSwitch()).catch(() => undefined);
  });

  browser.runtime.onMessage.addListener((message: PinCommand, sender, reply: (result: PinReply) => void) => {
    if (sender.id !== browser.runtime.id || sender.url !== browser.runtime.getURL('/sidepanel.html')) return false;
    if (!message || !['snapshot', 'switch', 'save', 'favorite'].includes(message.type)) return false;

    void enqueue(() => handleCommand(message, launchSeed)).then(reply, (error: unknown) => {
      reply({ error: error instanceof PinOperationError ? error.message : '插件操作失败，请重试。' });
    });
    return true;
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === deadlineAlarm) void enqueue(() => reconcileSwitch()).catch(() => undefined);
  });

  browser.cookies.onChanged.addListener(({ cookie, cause }) => {
    // Cookie 覆盖先触发移除，再触发写入，确认以最后一次写入为准。
    if (!isTestPinCookie(cookie) || cause === 'overwrite') return;
    void enqueue(() => reconcileSwitch()).catch(() => undefined);
  });
});
