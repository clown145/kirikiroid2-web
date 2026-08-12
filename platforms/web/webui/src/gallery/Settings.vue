<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../shared/api.js';
import AccountMenu from '../shared/AccountMenu.vue';
import SyncPanel from '../shared/SyncPanel.vue';
import { getDevice, listCloudSaves, localSaveSummary, setDeviceName } from '../shared/cloudSaves.js';
import { getSettings, setSetting } from '../shared/settings.js';

const settings = ref(getSettings());
const deviceName = ref(getDevice().name);
const account = ref(null);
const games = ref([]);
const localRows = ref([]);
const cloud = ref(null);
const loading = ref(true);
const status = ref('');
const showSync = ref(false);

const dirtyCount = computed(() => localRows.value.filter((row) => row.dirty).length);
const lastSyncedAt = computed(() => Math.max(0, ...localRows.value.map((row) => Number(row.lastSyncedAt || 0))));

function updateSetting(key, event) {
    settings.value = setSetting(key, event.target.checked);
}

function saveDeviceName() {
    deviceName.value = setDeviceName(deviceName.value).name;
    status.value = '设备名称已保存';
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
        localRows.value = await localSaveSummary(gameList);
        if (account.value) cloud.value = await listCloudSaves();
    } catch (err) {
        status.value = err.message || '读取设置状态失败';
    } finally {
        loading.value = false;
    }
}

onMounted(() => {
    document.title = '设置 · 游戏库';
    load();
});
</script>

<template>
    <header class="nav settings-nav">
        <a class="brand" href="/">
            <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20" aria-hidden="true">
                <path d="M21 6H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-10 7H8v3H6v-3H3v-2h3V8h2v3h3v2zm4.5 2c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm3-3c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z" />
            </svg>
            <span>Kirikiroid2</span>
        </a>
        <div class="settings-nav-actions">
            <a class="btn btn-ghost btn-sm" href="/">返回游戏库</a>
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
                <h2 id="download-settings">下载</h2>
                <p>控制游戏运行期间的资源获取方式。</p>
            </div>
            <label class="setting-row">
                <span>
                    <strong>游玩时继续下载资源</strong>
                    <small>开启后会在后台补齐未访问的分支资源，可能与当前读取争抢带宽。</small>
                </span>
                <input type="checkbox" :checked="settings.playWhileDownloading" @change="updateSetting('playWhileDownloading', $event)">
            </label>
        </section>

        <section class="settings-section" aria-labelledby="save-settings">
            <div class="section-title section-title-action">
                <div>
                    <h2 id="save-settings">云存档</h2>
                    <p>同步固定为手动模式，游戏运行时不会上传。</p>
                </div>
                <button class="btn btn-primary" :disabled="loading" @click="showSync = true">管理云存档</button>
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
                    <small>显示在云端版本历史中，帮助区分存档来源。</small>
                </span>
                <div class="device-input">
                    <input v-model="deviceName" class="input" maxlength="80" @keyup.enter="saveDeviceName">
                    <button class="btn" @click="saveDeviceName">保存</button>
                </div>
            </div>

            <dl class="save-stats">
                <div><dt>账号</dt><dd>{{ account?.displayName || '未登录' }}</dd></div>
                <div><dt>待同步游戏</dt><dd>{{ dirtyCount }}</dd></div>
                <div><dt>上次同步</dt><dd>{{ fmtTime(lastSyncedAt) }}</dd></div>
                <div><dt>云端用量</dt><dd>{{ cloud ? `${fmtBytes(cloud.usage.bytes)} / ${fmtBytes(cloud.usage.limit)}` : '登录后查看' }}</dd></div>
            </dl>
        </section>

        <p v-if="status" class="settings-status" aria-live="polite">{{ status }}</p>
    </main>

    <SyncPanel v-if="showSync" :games="games" :account="account" @close="showSync = false; load()" />
</template>

<style scoped>
.settings-nav { position: sticky; top: 0; z-index: var(--z-toolbar); display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: var(--space-3) var(--space-5); border-bottom: 1px solid var(--line); background: rgba(10, 10, 11, .86); backdrop-filter: blur(16px); }
.brand { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; }
.brand svg { color: var(--fg-1); }
.settings-nav-actions { display: flex; align-items: center; gap: 8px; }
.settings-body { width: min(860px, calc(100% - 32px)); margin: 0 auto; padding: 42px 0 80px; }
.settings-head { margin-bottom: 34px; }
.settings-head h1 { margin: 0 0 7px; font-size: 26px; letter-spacing: 0; }
.settings-head p, .section-title p { margin: 0; color: var(--fg-2); font-size: 12px; line-height: 1.6; }
.settings-section { border-top: 1px solid var(--line-strong); }
.settings-section + .settings-section { margin-top: 36px; }
.section-title { padding: 18px 0 14px; }
.section-title-action { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.section-title h2 { margin: 0 0 5px; font-size: 15px; }
.setting-row { min-height: 74px; display: flex; align-items: center; justify-content: space-between; gap: 28px; padding: 14px 0; border-top: 1px solid var(--line); }
.setting-row > span { min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.setting-row strong { font-size: 13px; font-weight: 550; }
.setting-row small { color: var(--fg-2); font-size: 11px; line-height: 1.55; }
.setting-row input[type="checkbox"] { width: 36px; height: 20px; flex: none; accent-color: var(--accent); }
.device-input { width: min(360px, 50%); display: flex; gap: 8px; }
.save-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 0; padding: 16px 0; border-top: 1px solid var(--line); }
.save-stats div { min-width: 0; padding-right: 16px; }
.save-stats dt { margin-bottom: 5px; color: var(--fg-2); font-size: 10px; }
.save-stats dd { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.settings-status { margin: 18px 0 0; color: var(--fg-1); font-size: 12px; }
@media (max-width: 680px) {
    .settings-nav { padding: var(--space-3) var(--space-4); }
    .brand span { display: none; }
    .settings-body { width: min(100% - 24px, 860px); padding-top: 26px; }
    .settings-nav-actions > a { display: none; }
    .section-title-action, .setting-row { align-items: flex-start; }
    .setting-row { gap: 14px; }
    .device-row { flex-direction: column; }
    .device-input { width: 100%; }
    .save-stats { grid-template-columns: 1fr 1fr; gap: 18px 10px; }
}
</style>
