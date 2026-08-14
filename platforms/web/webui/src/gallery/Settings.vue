<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../shared/api.js';
import AccountMenu from '../shared/AccountMenu.vue';
import BackToGallery from '../shared/BackToGallery.vue';
import SyncPanel from '../shared/SyncPanel.vue';
import {
    getDevice, getSyncBackend, getSyncProviderStatus, localSaveSummary, setDeviceName
} from '../shared/cloudSaves.js';
import { getSettings, setSetting } from '../shared/settings.js';
import {
    clearWebDavConfig, getWebDavConfig, saveWebDavConfig, testWebDavConnection
} from '../shared/webdav.js';
import { showConfirm } from '../shared/dialog.js';
import { toast } from '../shared/toast.js';

const settings = ref(getSettings());
const deviceName = ref(getDevice().name);
const account = ref(null);
const games = ref([]);
const localRows = ref([]);
const cloud = ref(null);
const loading = ref(true);
const status = ref('');
const showSync = ref(false);
const testingWebDav = ref(false);
const savedWebDav = getWebDavConfig();
const hasSavedWebDav = ref(!!savedWebDav);
const webDav = ref({
    name: savedWebDav?.name || '我的 WebDAV',
    url: savedWebDav?.url || '',
    username: savedWebDav?.username || '',
    password: savedWebDav?.password || '',
    root: savedWebDav?.root || 'Kirikiroid2',
    rememberPassword: !!savedWebDav?.rememberPassword
});

const dirtyCount = computed(() => localRows.value.filter((row) => row.dirty).length);
const lastSyncedAt = computed(() => Math.max(0, ...localRows.value.map((row) => Number(row.lastSyncedAt || 0))));
const storageUsageLabel = computed(() => settings.value.saveSyncProvider === 'webdav'
    ? '存储空间' : '站点云端用量');

function updateSetting(key, event) {
    settings.value = setSetting(key, event.target.checked);
}

function setDownloadMode(isStream) {
    settings.value = setSetting('playWhileDownloading', isStream);
}

async function selectSyncProvider(provider) {
    settings.value = setSetting('saveSyncProvider', provider);
    status.value = provider === 'webdav' && !getSyncProviderStatus().configured
        ? '请填写并测试 WebDAV 配置' : '';
    try { await loadSyncStatus(); }
    catch (err) { status.value = err.message || '读取同步状态失败'; }
}

function saveDeviceName() {
    deviceName.value = setDeviceName(deviceName.value).name;
    status.value = '设备名称已保存';
    toast.success('设备名称已保存');
}

async function saveAndTestWebDav() {
    if (testingWebDav.value) return;
    testingWebDav.value = true;
    status.value = '正在测试 WebDAV 连接…';
    try {
        const testRes = await testWebDavConnection(webDav.value);
        const config = saveWebDavConfig({
            ...webDav.value,
            supportsConditional: testRes?.supportsConditional !== false
        });
        webDav.value = { ...config };
        hasSavedWebDav.value = true;
        settings.value = setSetting('saveSyncProvider', 'webdav');
        const tip = testRes?.supportsConditional === false
            ? 'WebDAV 连接成功（以兼容模式运行），配置已保存'
            : 'WebDAV 连接成功，配置已保存';
        status.value = tip;
        toast.success(tip);
        await loadSyncStatus();
    } catch (err) {
        status.value = err.message || 'WebDAV 连接失败';
        toast.error(err.message || 'WebDAV 连接失败');
    } finally {
        testingWebDav.value = false;
    }
}

async function removeWebDav() {
    const ok = await showConfirm({
        title: '删除 WebDAV 配置',
        message: '删除这台设备上的 WebDAV 配置？远端存档不会被删除。',
        confirmText: '删除配置',
        danger: true
    });
    if (!ok) return;
    clearWebDavConfig();
    hasSavedWebDav.value = false;
    webDav.value = {
        name: '我的 WebDAV', url: '', username: '', password: '',
        root: 'Kirikiroid2', rememberPassword: false
    };
    if (settings.value.saveSyncProvider === 'webdav') {
        settings.value = setSetting('saveSyncProvider', 'site');
    }
    status.value = 'WebDAV 配置已删除，远端文件未改动';
    toast.success('WebDAV 配置已删除');
    loadSyncStatus().catch((err) => {
        status.value = err.message || '读取同步状态失败';
    });
}

function fmtBytes(bytes) {
    const value = Number(bytes || 0);
    return value >= 1048576 ? `${(value / 1048576).toFixed(1)} MB` : `${(value / 1024).toFixed(1)} KB`;
}

function fmtTime(value) {
    if (!value) return '从未同步';
    return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).format(new Date(value));
}

async function load() {
    try {
        const [accountResult, gameList] = await Promise.all([api.getAccount(), api.listGames()]);
        account.value = accountResult.user || null;
        games.value = gameList;
        await loadSyncStatus();
    } catch (err) {
        status.value = err.message || '读取设置状态失败';
    } finally {
        loading.value = false;
    }
}

async function loadSyncStatus() {
    cloud.value = null;
    let backend = null;
    try { backend = getSyncBackend(); } catch {}
    localRows.value = await localSaveSummary(games.value, backend);
    if (backend && (!backend.requiresAccount || account.value)) {
        cloud.value = await backend.list(games.value);
    }
}

onMounted(() => {
    document.title = '设置 · 游戏库';
    load();
});
</script>

<template>
    <header class="nav settings-nav">
        <BackToGallery />
        <div class="settings-nav-actions">
            <AccountMenu />
        </div>
    </header>

    <main class="settings-body">
        <header class="settings-head">
            <div>
                <h1>设置</h1>
                <p>所有选项在游戏库和播放页之间共用。</p>
            </div>
        </header>

        <section class="settings-section" aria-labelledby="download-settings">
            <div class="section-title">
                <h2 id="download-settings">下载与加载</h2>
                <p>控制游戏运行期间的资源获取方式与存储行为。</p>
            </div>

            <div class="setting-mode-group" role="radiogroup" aria-label="游戏加载模式">
                <label
                    class="setting-mode-card"
                    :class="{ active: settings.playWhileDownloading }">
                    <div class="mode-card-radio">
                        <input
                            type="radio"
                            name="settings-download-mode"
                            :checked="settings.playWhileDownloading"
                            @change="setDownloadMode(true)">
                    </div>
                    <div class="mode-card-content">
                        <div class="mode-card-title">
                            <strong>⚡ 边下边玩 · 流畅模式</strong>
                            <span class="recommend-badge">推荐</span>
                        </div>
                        <small>进入游戏秒开，后台自动预载剩余章节与素材。彻底消除剧情翻页和语音加载等待，游玩后自动保留完整离线版。（推荐在 Wi-Fi / 宽带环境）</small>
                    </div>
                </label>

                <label
                    class="setting-mode-card"
                    :class="{ active: !settings.playWhileDownloading }">
                    <div class="mode-card-radio">
                        <input
                            type="radio"
                            name="settings-download-mode"
                            :checked="!settings.playWhileDownloading"
                            @change="setDownloadMode(false)">
                    </div>
                    <div class="mode-card-content">
                        <div class="mode-card-title">
                            <strong>💧 纯按需读取 · 省流模式</strong>
                        </div>
                        <small>读到哪段剧情才实时下载当前资源，最省流量；但初次经过新场景或弱网时可能会有短暂加载等待。（适合移动蜂窝流量计费环境）</small>
                    </div>
                </label>
            </div>

            <label class="setting-row">
                <span>
                    <strong>完整下载前建议选择文件夹</strong>
                    <small>文件夹里的游戏不会随浏览器缓存被清除；关闭后会直接使用浏览器内部存储。</small>
                </span>
                <input type="checkbox" :checked="settings.downloadFolderPrompt" @change="updateSetting('downloadFolderPrompt', $event)">
            </label>
        </section>

        <section class="settings-section" aria-labelledby="save-settings">
            <div class="section-title section-title-action">
                <div>
                    <h2 id="save-settings">存档同步</h2>
                    <p>同步固定为手动模式，游戏运行时不会上传。</p>
                </div>
                <button class="btn btn-primary" :disabled="loading" @click="showSync = true">管理同步</button>
            </div>

            <div class="setting-row provider-row">
                <span>
                    <strong>同步位置</strong>
                    <small>站点云存档需要登录；WebDAV 由浏览器直接连接你的服务器。</small>
                </span>
                <div class="segmented" role="radiogroup" aria-label="存档同步位置">
                    <button type="button" role="radio"
                        :aria-checked="settings.saveSyncProvider === 'site'"
                        :class="{ active: settings.saveSyncProvider === 'site' }"
                        @click="selectSyncProvider('site')">
                        站点云存档
                    </button>
                    <button type="button" role="radio"
                        :aria-checked="settings.saveSyncProvider === 'webdav'"
                        :class="{ active: settings.saveSyncProvider === 'webdav' }"
                        @click="selectSyncProvider('webdav')">
                        WebDAV
                    </button>
                </div>
            </div>

            <div v-if="settings.saveSyncProvider === 'webdav'" class="webdav-settings">
                <p class="webdav-privacy">
                    浏览器会直接连接 WebDAV，地址和凭据不会发送给本站。
                    <a href="/help#webdav">查看服务器要求</a>
                </p>
                <div class="webdav-grid">
                    <label class="field">
                        <span>配置名称</span>
                        <input v-model="webDav.name" class="input" maxlength="80" autocomplete="off">
                    </label>
                    <label class="field webdav-url">
                        <span>WebDAV URL</span>
                        <input v-model="webDav.url" class="input" type="url"
                            placeholder="https://dav.example.com/remote.php/dav/files/user" autocomplete="url">
                    </label>
                    <label class="field">
                        <span>用户名</span>
                        <input v-model="webDav.username" class="input" autocomplete="username">
                    </label>
                    <label class="field">
                        <span>密码</span>
                        <input v-model="webDav.password" class="input" type="password"
                            autocomplete="current-password">
                    </label>
                    <label class="field webdav-url">
                        <span>远端目录</span>
                        <input v-model="webDav.root" class="input" placeholder="Kirikiroid2" autocomplete="off">
                    </label>
                </div>
                <label class="remember-password">
                    <input v-model="webDav.rememberPassword" type="checkbox">
                    <span>
                        <strong>在这台设备上记住密码</strong>
                        <small>开启后密码会保存在浏览器本地；建议使用 WebDAV 应用专用密码。</small>
                    </span>
                </label>
                <div class="webdav-actions">
                    <button v-if="hasSavedWebDav" class="btn btn-ghost" type="button"
                        :disabled="testingWebDav" @click="removeWebDav">删除配置</button>
                    <button class="btn btn-primary" type="button" :disabled="testingWebDav"
                        @click="saveAndTestWebDav">
                        <span v-if="testingWebDav" class="spinner" aria-hidden="true" />
                        {{ testingWebDav ? '正在测试' : '保存并测试' }}
                    </button>
                </div>
            </div>

            <label class="setting-row">
                <span>
                    <strong>回到游戏库时提醒同步</strong>
                    <small>只显示待同步提示，不会自动上传或覆盖任何版本。</small>
                </span>
                <input type="checkbox" :checked="settings.saveSyncReminder" @change="updateSetting('saveSyncReminder', $event)">
            </label>

            <div class="setting-row device-row">
                <span>
                    <strong>设备名称</strong>
                    <small>显示在远端版本历史中，帮助区分存档来源。</small>
                </span>
                <div class="device-input">
                    <input v-model="deviceName" class="input" maxlength="80" @keyup.enter="saveDeviceName">
                    <button class="btn" @click="saveDeviceName">保存</button>
                </div>
            </div>

            <dl class="save-stats">
                <div><dt>同步位置</dt><dd>{{ getSyncProviderStatus().label }}</dd></div>
                <div><dt>待同步游戏</dt><dd>{{ dirtyCount }}</dd></div>
                <div><dt>上次同步</dt><dd>{{ fmtTime(lastSyncedAt) }}</dd></div>
                <div><dt>{{ storageUsageLabel }}</dt><dd>{{ cloud?.usage ? `${fmtBytes(cloud.usage.bytes)} / ${fmtBytes(cloud.usage.limit)}` : '由存储服务管理' }}</dd></div>
            </dl>
            <p class="sync-help"><a href="/help#sync">了解手动同步、冲突处理与数据存储方式</a></p>
        </section>

        <p v-if="status" class="settings-status" aria-live="polite">{{ status }}</p>
    </main>

    <SyncPanel v-if="showSync" :games="games" :account="account" @close="showSync = false; load()" />
</template>

<style scoped>
.settings-nav { position: sticky; top: 0; z-index: var(--z-toolbar); display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: var(--space-3) var(--space-5); border-bottom: 1px solid var(--line); background: rgba(10, 10, 11, .86); backdrop-filter: blur(16px); }
.settings-nav-actions { display: flex; align-items: center; gap: 8px; }
.settings-body { width: min(860px, calc(100% - 32px)); margin: 0 auto; padding: 42px 0 80px; }
.settings-head { margin-bottom: 34px; }
.settings-head h1 { margin: 0 0 7px; font-size: 26px; letter-spacing: 0; }
.settings-head p, .section-title p { margin: 0; color: var(--fg-2); font-size: 12px; line-height: 1.6; }
.settings-section { border-top: 1px solid var(--line-strong); }
.settings-section + .settings-section { margin-top: 36px; }
.section-title { padding: 18px 0 14px; }
.section-title-action { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.setting-mode-group { display: flex; flex-direction: column; gap: var(--space-2); margin-bottom: 8px; }
.setting-mode-card { display: flex; align-items: flex-start; gap: var(--space-3); padding: var(--space-3) var(--space-4); border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-2); cursor: pointer; transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease); }
.setting-mode-card:hover { background: var(--bg-3); border-color: var(--line-strong); }
.setting-mode-card.active { background: var(--bg-3); border-color: var(--accent); }
.setting-mode-card .mode-card-radio { margin-top: 2px; }
.setting-mode-card .mode-card-radio input[type="radio"] { accent-color: var(--fg-0); cursor: pointer; }
.setting-mode-card .mode-card-content { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; }
.setting-mode-card .mode-card-title { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
.setting-mode-card strong { font-size: 13px; font-weight: 600; color: var(--fg-0); }
.setting-mode-card small { color: var(--fg-1); font-size: 11px; line-height: 1.55; }
.recommend-badge { padding: 1px 6px; border-radius: 4px; background: rgba(250, 204, 21, 0.15); color: #fde047; border: 1px solid rgba(250, 204, 21, 0.3); font-size: 10px; font-weight: 600; }
.setting-row { min-height: 74px; display: flex; align-items: center; justify-content: space-between; gap: 28px; padding: 14px 0; border-top: 1px solid var(--line); }
.setting-row > span { min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.setting-row strong { font-size: 13px; font-weight: 550; }
.setting-row small { color: var(--fg-2); font-size: 11px; line-height: 1.55; }
.setting-row input[type="checkbox"] { width: 36px; height: 20px; flex: none; accent-color: var(--accent); }
.device-input { width: min(360px, 50%); display: flex; gap: 8px; }
.provider-row { align-items: center; }
.segmented { display: grid; grid-template-columns: 1fr 1fr; flex: none; padding: 3px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--bg-2); }
.segmented button { min-height: 32px; padding: 5px 12px; border-radius: 5px; color: var(--fg-2); font-size: 12px; white-space: nowrap; }
.segmented button.active { background: var(--fg-0); color: var(--bg-0); }
.webdav-settings { padding: 18px 0; border-top: 1px solid var(--line); }
.webdav-privacy { margin: 0 0 16px; color: var(--fg-2); font-size: 11px; line-height: 1.6; }
.webdav-privacy a, .sync-help a { color: var(--fg-1); text-decoration: underline; }
.webdav-privacy a:hover, .sync-help a:hover { color: var(--fg-0); }
.webdav-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.webdav-grid .field > span { color: var(--fg-1); font-size: 11px; font-weight: 500; }
.webdav-url { grid-column: 1 / -1; }
.remember-password { display: flex; align-items: flex-start; gap: 10px; margin-top: 16px; }
.remember-password input { width: 17px; height: 17px; margin: 1px 0 0; accent-color: var(--accent); }
.remember-password span { display: flex; flex-direction: column; gap: 3px; }
.remember-password strong { font-size: 12px; }
.remember-password small { color: var(--fg-2); font-size: 10px; line-height: 1.5; }
.webdav-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
.save-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 0; padding: 16px 0; border-top: 1px solid var(--line); }
.save-stats div { min-width: 0; padding-right: 16px; }
.save-stats dt { margin-bottom: 5px; color: var(--fg-2); font-size: 10px; }
.save-stats dd { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.sync-help { margin: 0; padding: 0 0 16px; font-size: 11px; }
.settings-status { margin: 18px 0 0; color: var(--fg-1); font-size: 12px; }
@media (max-width: 680px) {
    .settings-nav { padding: var(--space-3) var(--space-4); }
    .settings-body { width: min(100% - 24px, 860px); padding-top: 26px; }
    .section-title-action, .setting-row { align-items: flex-start; }
    .setting-row { gap: 14px; }
    .device-row { flex-direction: column; }
    .device-input { width: 100%; }
    .provider-row { flex-direction: column; }
    .segmented { width: 100%; }
    .webdav-grid { grid-template-columns: 1fr; }
    .webdav-url { grid-column: auto; }
    .webdav-actions { display: grid; grid-template-columns: 1fr; }
    .webdav-actions .btn { justify-content: center; }
    .save-stats { grid-template-columns: 1fr 1fr; gap: 18px 10px; }
}
</style>
