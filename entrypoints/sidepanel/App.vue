<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue';
import { Check, Copy, Link2, LoaderCircle, Moon, Pencil, Plus, Search, Star, Sun } from '@lucide/vue';
import { browser } from 'wxt/browser';
import {
  buildSeedUrl, compareByRecentUse, isTestPinCookie, pendingKey, recordsKey,
  type AttemptStatus, type PinCommand, type PinRecord, type PinReply, type PinSnapshot,
} from '../../lib/pins';

/** 侧边栏可保存的外观选项 */
type Theme = 'light' | 'dark';

/** 当前 Chrome 配置文件的外观偏好键 */
const themeKey = 'sidepanelTheme';

/** 浏览器提供的系统颜色偏好 */
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');

/** 没有手动选择时使用的系统主题 */
const systemDark = ref(systemTheme.matches);

/** 用户手动选择的主题，空值表示跟随系统 */
const themePreference = ref<Theme>();

/** 偏好完成读取后再开放切换 */
const themeLoaded = ref(false);

/** 当前渲染的主题 */
const theme = computed<Theme>(() => themePreference.value ?? (systemDark.value ? 'dark' : 'light'));

/** 图标按钮提供的下一步操作 */
const themeAction = computed(() => theme.value === 'dark' ? '切换到浅色模式' : '切换到深色模式');

/** 在页面根节点应用主题，让表单控件和背景同步更新 */
watch(theme, (value) => {
  document.documentElement.dataset.theme = value;
}, { immediate: true });

/** 系统外观变化时同步未手动设置的面板 */
function onSystemThemeChanged(event: MediaQueryListEvent): void {
  systemDark.value = event.matches;
}

/** 应用从本地存储读取的有效主题偏好 */
function restoreTheme(value: unknown): void {
  themePreference.value = value === 'light' || value === 'dark' ? value : undefined;
}

/** 切换到另一套外观并保存偏好 */
async function toggleTheme(): Promise<void> {
  // 在点击时取当前有效主题，首次手动切换也能正确取反。
  const nextTheme = theme.value === 'dark' ? 'light' : 'dark';
  try {
    await browser.storage.local.set({ [themeKey]: nextTheme });
    restoreTheme(nextTheme);
  } catch {
    errorMessage.value = '暂时无法保存外观设置，请重试。';
  }
}

/** 面板当前显示的账号与记录 */
const snapshot = ref<PinSnapshot>();

/** 当前打开的记录筛选标签 */
const activeTab = ref<'records' | 'favorites'>('records');

/** 快速种 PIN 输入值 */
const pinInput = ref('');

/** 记录搜索关键字 */
const query = ref('');

/** 新增或修改备注时填写的信息 */
const editor = ref<{ pin: string; note: string; editing: boolean }>();

/** 备注表单中优先获得焦点的输入框 */
const editorPin = useTemplateRef<HTMLInputElement>('editorPin');

/** 编辑或新增时使用的备注输入框 */
const editorNote = useTemplateRef<HTMLInputElement>('editorNote');

/** 正在发送切换命令，防止后台接收前重复点击 */
const submitting = ref(false);

/** 编辑表单写入防重 */
const saving = ref(false);

/** 用户刚发起切换的目标，用来展示本次结果 */
const targetPin = ref('');

/** 面板需要展示的操作错误 */
const errorMessage = ref('');

/** 最近一次成功的复制动作 */
const copied = ref<'pin' | 'link'>();

/** 只接受最新后台响应，避免较慢的快照覆盖新界面 */
let requestVersion = 0;

/** 面板可见期间补查测试 PIN 的间隔 */
const pinRefreshInterval = 2_000;

/** 面板关闭时需要取消的定时刷新 */
let refreshTimer: ReturnType<typeof setInterval> | undefined;

/** 用于自动收起复制反馈的计时器 */
let copyTimer: ReturnType<typeof setTimeout> | undefined;

/** 用于对齐记录语义和界面文案的状态名 */
const statusText: Record<AttemptStatus, string> = {
  pending: '待确认',
  confirmed: '已确认',
  unconfirmed: '未能确认',
  failed: '发起失败',
};

/** 面板里的本地记录 */
const records = computed(() => snapshot.value?.records ?? []);

/** 仅使用从测试 Cookie 核验出的当前身份 */
const currentPin = computed(() => {
  // 未加载和权限异常的状态都在当前账号卡上独立显示。
  const current = snapshot.value?.current;
  return current?.status === 'verified' ? current.pin : '';
});

/** 账号变化后收起上一枚 PIN 的复制提示 */
watch(currentPin, () => {
  copied.value = undefined;
  clearTimeout(copyTimer);
});

/** 当前账号关联的本地备注 */
const currentNote = computed(() => records.value.find((record) => record.pin === currentPin.value)?.note ?? '');

/** 当前账号为空时的说明 */
const currentPlaceholder = computed(() => {
  if (!snapshot.value) return errorMessage.value ? '暂不可读取' : '读取中…';
  return snapshot.value.current.status === 'missing' ? '未检测到测试 PIN' : '暂不可核验';
});

/** 后台占用切换时保留记录和备注操作 */
const busy = computed(() => submitting.value || Boolean(snapshot.value?.pending));

/** 收藏标签显示的账号数 */
const favoriteCount = computed(() => records.value.filter((record) => record.favorite).length);

/** 当前标签中的有序记录，不改变原始数据 */
const visibleRecords = computed(() => {
  // 搜索只影响记录标签，收藏标签始终显示已收藏账号。
  const filter = query.value.trim().toLowerCase();
  return records.value.filter((record) => activeTab.value === 'favorites'
    ? record.favorite
    : !filter || (record.pin + ' ' + record.note).toLowerCase().includes(filter),
  ).sort(compareByRecentUse);
});

/** 横跨种 PIN、等待确认和最终结果的反馈 */
const switchMessage = computed(() => {
  if (submitting.value) return '正在打开测试网关…';
  if (snapshot.value?.pending) return '已发起，正在核验 ' + snapshot.value.pending.pin + '…';
  // 按用户刚触发的目标取结果，避免旧记录抢占反馈区。
  const status = records.value.find((record) => record.pin === targetPin.value)?.lastAttempt?.status;
  if (status === 'confirmed' && currentPin.value === targetPin.value) return '切换完成，可刷新业务页';
  if (status === 'unconfirmed') return '未能确认切换，请查看测试网关或重试。';
  if (status === 'failed') return '无法发起切换，可在种 PIN 记录中重试。';
  return '';
});

/** 根据时间戳展示用户本地时间 */
function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(timestamp);
}

/** 向后台发送操作并刷新视图 */
async function send(command: PinCommand): Promise<boolean> {
  // 快照推送可能与按钮命令并发，旧响应不能回退 UI。
  const version = ++requestVersion;
  try {
    // 后台统一序列化写入和身份核验。
    const reply = await browser.runtime.sendMessage(command) as PinReply | undefined;
    if (!reply) throw new Error();
    if ('error' in reply) {
      errorMessage.value = reply.error;
      return false;
    }
    if (version === requestVersion) snapshot.value = reply.snapshot;
    return true;
  } catch {
    errorMessage.value = '暂时无法连接插件后台，请重试。';
    return false;
  }
}

/** 读取身份和记录变化 */
function refresh(): void {
  void send({ type: 'snapshot' });
}

/** 从输入框或记录发起账号切换 */
async function switchPin(value: string): Promise<void> {
  if (busy.value) return;
  // PIN 保留原大小写，只过滤输入中的首尾空白。
  const pin = value.trim();
  errorMessage.value = '';
  if (!pin) {
    errorMessage.value = '请输入测试 PIN。';
    return;
  }
  submitting.value = true;
  targetPin.value = pin;
  pinInput.value = pin;
  try {
    await send({ type: 'switch', pin });
  } finally {
    submitting.value = false;
  }
}

/** 在侧边栏内展开新增或改备注表单 */
async function openEditor(record?: PinRecord): Promise<void> {
  errorMessage.value = '';
  editor.value = { pin: record?.pin ?? pinInput.value.trim(), note: record?.note ?? '', editing: Boolean(record) };
  await nextTick();
  if (record) editorNote.value?.focus();
  else editorPin.value?.focus();
}

/** 保存记录，已有 PIN 复用同一条目 */
async function saveEditor(): Promise<void> {
  if (!editor.value || saving.value) return;
  errorMessage.value = '';
  saving.value = true;
  try {
    if (await send({ type: 'save', pin: editor.value.pin, note: editor.value.note })) {
      editor.value = undefined;
      query.value = '';
    }
  } finally {
    saving.value = false;
  }
}

/** 更新单条记录的星标状态 */
function toggleFavorite(pin: string): void {
  errorMessage.value = '';
  void send({ type: 'favorite', pin });
}

/** 复制已核验的账号或账号对应网关链接 */
async function copyCurrent(kind: 'pin' | 'link'): Promise<void> {
  if (!currentPin.value) return;
  errorMessage.value = '';
  try {
    await navigator.clipboard.writeText(kind === 'pin' ? currentPin.value : buildSeedUrl(currentPin.value));
    copied.value = kind;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copied.value = undefined; }, 1600);
  } catch {
    errorMessage.value = '复制失败，请重试。';
  }
}

/** 监听记录和进行中状态的持久化变更 */
const onStorageChanged: Parameters<typeof browser.storage.onChanged.addListener>[0] = (changes, area) => {
  if (area === 'local' && changes[themeKey]) restoreTheme(changes[themeKey].newValue);
  if ((area === 'local' && changes[recordsKey]) || (area === 'session' && changes[pendingKey])) refresh();
};

/** 手动访问种 PIN URL 后，直接响应浏览器的 Cookie 变化 */
const onTestPinCookieChanged: Parameters<typeof browser.cookies.onChanged.addListener>[0] = ({ cookie, cause }) => {
  if (cause !== 'overwrite' && isTestPinCookie(cookie)) refresh();
};

/** 面板可见时重新核验，补偿浏览器事件未送达的情况 */
function refreshVisible(): void {
  if (document.visibilityState === 'visible') refresh();
}

onMounted(() => {
  browser.storage.onChanged.addListener(onStorageChanged);
  systemTheme.addEventListener('change', onSystemThemeChanged);
  void browser.storage.local.get(themeKey).then((stored) => {
    restoreTheme(stored[themeKey]);
  }).catch(() => {
    // 存储暂不可读时继续使用当前系统外观。
  }).finally(() => {
    themeLoaded.value = true;
  });
  browser.cookies.onChanged.addListener(onTestPinCookieChanged);
  window.addEventListener('focus', refreshVisible);
  document.addEventListener('visibilitychange', refreshVisible);
  refreshTimer = setInterval(refreshVisible, pinRefreshInterval);
  refresh();
});

onUnmounted(() => {
  browser.storage.onChanged.removeListener(onStorageChanged);
  systemTheme.removeEventListener('change', onSystemThemeChanged);
  browser.cookies.onChanged.removeListener(onTestPinCookieChanged);
  window.removeEventListener('focus', refreshVisible);
  document.removeEventListener('visibilitychange', refreshVisible);
  clearInterval(refreshTimer);
  clearTimeout(copyTimer);
});
</script>

<template>
  <main class="panel">
    <header class="panel-header">
      <h1>测试 PIN</h1>
      <div class="header-actions">
        <span>测试环境</span>
        <button
          type="button" class="button button-secondary theme-toggle" :disabled="!themeLoaded"
          :aria-label="themeAction" :title="themeAction" @click="toggleTheme"
        >
          <Sun v-if="theme === 'dark'" :size="17" aria-hidden="true" />
          <Moon v-else :size="17" aria-hidden="true" />
        </button>
      </div>
    </header>

    <section class="current-card" aria-labelledby="current-label">
      <div class="current-heading">
        <h2 id="current-label">当前 PIN</h2>
        <strong v-if="currentPin" class="pin-value current-pin-value">{{ currentPin }}</strong>
        <span v-else class="current-placeholder">{{ currentPlaceholder }}</span>
      </div>
      <p v-if="currentNote" class="current-note"><span>备注</span>{{ currentNote }}</p>
      <div class="copy-actions">
        <button type="button" class="button button-secondary" :disabled="!currentPin" @click="copyCurrent('pin')">
          <Check v-if="copied === 'pin'" :size="15" aria-hidden="true" />
          <Copy v-else :size="15" aria-hidden="true" />
          {{ copied === 'pin' ? '已复制 PIN' : '复制当前 PIN' }}
        </button>
        <button type="button" class="button button-secondary" :disabled="!currentPin" @click="copyCurrent('link')">
          <Check v-if="copied === 'link'" :size="15" aria-hidden="true" />
          <Link2 v-else :size="15" aria-hidden="true" />
          {{ copied === 'link' ? '已复制链接' : '复制种 PIN 链接' }}
        </button>
      </div>
    </section>

    <form class="quick-form" @submit.prevent="switchPin(pinInput)">
      <label for="quick-pin">快速种 PIN</label>
      <div class="form-row">
        <input id="quick-pin" v-model="pinInput" autocomplete="off" placeholder="输入测试 PIN">
        <button type="submit" class="button button-primary" :disabled="busy || !snapshot">
          <LoaderCircle v-if="busy" class="spinner" :size="16" aria-hidden="true" />
          {{ busy ? '切换中' : '种 PIN' }}
        </button>
      </div>
      <p v-if="switchMessage" class="switch-message" role="status">{{ switchMessage }}</p>
      <p v-if="errorMessage" class="error-message" role="alert">{{ errorMessage }}</p>
    </form>

    <nav class="tabs" aria-label="PIN 列表">
      <button type="button" :aria-pressed="activeTab === 'records'" @click="activeTab = 'records'">种 PIN 记录</button>
      <button type="button" :aria-pressed="activeTab === 'favorites'" @click="activeTab = 'favorites'">
        收藏 <span v-if="favoriteCount">{{ favoriteCount }}</span>
      </button>
    </nav>

    <div v-if="activeTab === 'records'" class="form-row list-tools">
      <label class="search-field">
        <Search :size="16" aria-hidden="true" />
        <input v-model="query" aria-label="搜索 PIN 或备注" placeholder="搜索 PIN 或备注">
      </label>
      <button type="button" class="button button-secondary" @click="openEditor()">
        <Plus :size="15" aria-hidden="true" /> 添加
      </button>
    </div>

    <form v-if="editor && activeTab === 'records'" class="editor" @submit.prevent="saveEditor">
      <h2>{{ editor.editing ? '编辑备注' : '添加 PIN' }}</h2>
      <label for="editor-pin">PIN</label>
      <input id="editor-pin" ref="editorPin" v-model="editor.pin" :readonly="editor.editing" required autocomplete="off">
      <label for="editor-note">备注</label>
      <input id="editor-note" ref="editorNote" v-model="editor.note" maxlength="80" placeholder="例如：体验金待领取">
      <div class="form-row">
        <button class="button button-primary" :disabled="saving">保存</button>
        <button type="button" class="button button-secondary" @click="editor = undefined">取消</button>
      </div>
    </form>

    <ul v-if="visibleRecords.length" class="records" aria-label="测试 PIN 列表">
      <li v-for="record in visibleRecords" :key="record.pin" class="record">
        <div class="record-info">
          <strong class="pin-value">{{ record.pin }}</strong>
          <p v-if="record.note">{{ record.note }}</p>
          <div v-if="activeTab === 'records' && record.lastAttempt" class="attempt">
            <time :datetime="new Date(record.lastAttempt.startedAt).toISOString()">{{ formatTime(record.lastAttempt.startedAt) }}</time>
            <span :data-status="record.lastAttempt.status">{{ statusText[record.lastAttempt.status] }}</span>
          </div>
        </div>
        <div class="record-actions">
          <button
            type="button" class="button button-icon star" :class="{ 'is-favorite': record.favorite }"
            :aria-label="(record.favorite ? '取消收藏 ' : '收藏 ') + record.pin"
            :title="record.favorite ? '取消收藏' : '收藏'" @click="toggleFavorite(record.pin)"
          >
            <Star :size="17" aria-hidden="true" />
          </button>
          <button
            v-if="activeTab === 'records'" type="button" class="button button-icon"
            :aria-label="'改备注 ' + record.pin" title="改备注" @click="openEditor(record)"
          >
            <Pencil :size="15" aria-hidden="true" />
          </button>
          <button
            type="button" class="button button-secondary" :disabled="busy"
            :aria-label="(record.lastAttempt?.status === 'unconfirmed' || record.lastAttempt?.status === 'failed' ? '重试 ' : '种 PIN ') + record.pin"
            @click="switchPin(record.pin)"
          >
            {{ record.lastAttempt?.status === 'unconfirmed' || record.lastAttempt?.status === 'failed' ? '重试' : '种 PIN' }}
          </button>
        </div>
      </li>
    </ul>
    <p v-else-if="snapshot" class="empty">
      {{ activeTab === 'favorites' ? '还没有收藏的 PIN' : query.trim() ? '没有匹配的 PIN' : '暂无种 PIN 记录' }}
    </p>
  </main>
</template>
