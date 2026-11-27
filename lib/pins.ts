import { readGatewayConfig } from './gateway-config';

/** 从构建环境读取本地指定的测试网关与身份标识 */
const gateway = readGatewayConfig(import.meta.env.WXT_PIN_GATEWAY_URL, import.meta.env.WXT_PIN_COOKIE_NAME);

/** 测试网关写入的身份 Cookie 名称 */
export const testPinCookieName = gateway.cookieName;

/** 生成链接与读取 Cookie 都使用同一个测试地址 */
export const testPinUrl = gateway.url;

/** 判断变更是否属于当前测试入口的身份 Cookie */
export function isTestPinCookie(cookie: { name: string; domain: string; hostOnly: boolean }): boolean {
  if (cookie.name !== testPinCookieName) return false;

  // 只匹配测试域本身，或明确适用于测试域的父域 Cookie。
  const domain = cookie.domain.replace(/^\./, '');
  const hostname = new URL(testPinUrl).hostname;
  return hostname === domain || (!cookie.hostOnly && hostname.endsWith('.' + domain));
}

/** 保存记录的本地存储键 */
export const recordsKey = 'pinRecords';

/** 保存进行中操作的会话存储键 */
export const pendingKey = 'pendingPinSwitch';

/** 扩展内一次种 PIN 的业务状态 */
export type AttemptStatus = 'pending' | 'confirmed' | 'unconfirmed' | 'failed';

/** 最近一次切换的结果 */
export interface PinAttempt {
  id: string;
  startedAt: number;
  status: AttemptStatus;
  pageReload?: 'requested' | 'skipped';
}

/** 每个测试 PIN 对应的一条本地记录 */
export interface PinRecord {
  pin: string;
  note: string;
  favorite: boolean;
  lastUsedAt?: number;
  lastAttempt?: PinAttempt;
}

/** 可在后台 Worker 重启后恢复的单次操作 */
export interface PendingSwitch {
  id: string;
  pin: string;
  startedAt: number;
  deadline: number;
  responseReceived?: boolean;
  refreshTabId?: number;
}

/** 面板展示的实时身份核验结果 */
export type CurrentPin =
  | { status: 'verified'; pin: string }
  | { status: 'missing' | 'unavailable' };

/** 侧边栏一次加载所需的数据 */
export interface PinSnapshot {
  current: CurrentPin;
  records: PinRecord[];
  pending?: PendingSwitch;
}

/** 面板发送到后台的本地命令 */
export type PinCommand =
  | { type: 'snapshot' }
  | { type: 'switch'; pin: string; refreshTabId?: number }
  | { type: 'save'; pin: string; note: string }
  | { type: 'favorite'; pin: string };

/** 后台对面板操作的响应 */
export type PinReply = { snapshot: PinSnapshot } | { error: string };

/** 将原样 PIN 作为一个查询参数写入测试地址 */
export function buildSeedUrl(pin: string): string {
  // 使用标准 URL 编码处理空格、加号与其他特殊字符。
  const url = new URL(testPinUrl);
  url.searchParams.set('pin', pin);
  return url.href;
}

/** 最近确认的账号优先，无成功记录时按最近尝试排序 */
export function compareByRecentUse(left: PinRecord, right: PinRecord): number {
  return (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0)
    || (right.lastAttempt?.startedAt ?? 0) - (left.lastAttempt?.startedAt ?? 0);
}
