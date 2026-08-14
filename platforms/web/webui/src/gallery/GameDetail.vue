<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { Cloud } from '@lucide/vue';
import { api, coverSrc } from '../shared/api.js';
import AccountMenu from '../shared/AccountMenu.vue';
import BackToGallery from '../shared/BackToGallery.vue';
import DownloadLocationDialog from '../shared/DownloadLocationDialog.vue';
import SyncPanel from '../shared/SyncPanel.vue';
import GameLeaderboard from './GameLeaderboard.vue';
import { useFolderAccess } from '../shared/folderAccess.js';
import { getSetting, requestDownloadHandoff, setSetting } from '../shared/settings.js';
import { toast } from '../shared/toast.js';

const cleanPath = location.pathname.replace(/\/+$/, '');
const gameId = decodeURIComponent(cleanPath.replace(/^\/game\/?/, ''));
const game = ref(null);
const loading = ref(true);
const loadError = ref('');
const coverFailed = ref(false);
const cacheInfo = ref(null);
const downloading = ref(null);
const pendingDownload = ref(false);
const storage = ref(null);
const dismissedFolderPrompt = ref(false);
const account = ref(null);
const showSync = ref(false);
const preparingDownload = ref(false);
const folderAccess = useFolderAccess();
let pollTimer = null;

watch(folderAccess.version, async () => {
    await refreshStorage(false);
    await refreshCache();
});

watch(folderAccess.needsPermission, () => refreshStorage(false));

function isFolderPermissionError(error) {
    return error?.code === 'folder-permission-required';
}

async function waitForFolderAccess(resumeDownload = false) {
    cacheInfo.value = null;
    await refreshStorage(false);
    const result = await folderAccess.requireAccess();
    await refreshStorage(false);
    await refreshCache();
    if (resumeDownload && (result === 'granted' || result === 'unbound')) await beginDownload();
}

async function refreshStorage(prompt = true) {
    if (!window.KrKr2Cache) return;
    storage.value = await window.KrKr2Cache.storageInfo();
    if (storage.value.needsPermission) {
        cacheInfo.value = null;
        if (prompt) folderAccess.prompt();
    }
}

const cover = computed(() => (coverFailed.value ? null : coverSrc(game.value)));
const initial = computed(() => (game.value?.title || '?').trim().charAt(0).toUpperCase());
const cached = computed(() => !!cacheInfo.value?.complete);
const partialPct = computed(() => {
    const c = cacheInfo.value;
    if (!c || !c.size || c.complete) return 0;
    return Math.min(99, Math.round((c.bytes / c.size) * 100));
});
const downloadPct = computed(() =>
    downloading.value?.pct ?? (cached.value ? 100 : partialPct.value));
const downloadLabel = computed(() => {
    if (preparingDownload.value) return '准备中';
    if (cached.value) return '已下载';
    if (downloading.value?.retrying) return '续传中';
    if (downloading.value?.finalizing) return '写入中';
    if (downloading.value) return `${downloading.value.pct}%`;
    if (partialPct.value) return `继续下载（已有 ${partialPct.value}%）`;
    return '完整下载';
});

function fmt(bytes) {
    if (!bytes) return '0 MB';
    const mb = bytes / 1048576;
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

async function refreshCache() {
    if (!window.KrKr2Cache || !game.value) return;
    try {
        const list = await window.KrKr2Cache.list();
        cacheInfo.value = list.find((item) => item.gameKey === game.value.id) || null;
    } catch (error) {
        if (isFolderPermissionError(error)) await refreshStorage(false);
        // 缓存不可用不影响详情页和直接游玩
    }
}

function pollDownload() {
    const state = window.KrKr2Cache?.downloadState?.() || null;
    downloading.value = state?.gameKey === game.value?.id ? state : null;
    if (state?.done && state.gameKey === game.value?.id) {
        downloading.value = null;
        window.KrKr2Cache?.stopDownload();
        refreshCache();
    }
}

async function beginDownload() {
    if (!game.value?.downloadUrl || !window.KrKr2Cache) return;
    preparingDownload.value = true;
    try {
        await window.KrKr2Cache.download({
            gameKey: game.value.id,
            title: game.value.title,
            url: game.value.downloadUrl.trim(),
            onDone: refreshCache,
            onError: (error) => {
                window.KrKr2Cache.stopDownload().finally(async () => {
                    downloading.value = null;
                    if (isFolderPermissionError(error)) {
                        await waitForFolderAccess(true);
                    } else {
                        await refreshCache();
                        toast.warn('下载已停止：' + (error?.message || error || '未知错误'));
                    }
                });
            }
        });
        pollDownload();
    } catch (err) {
        if (isFolderPermissionError(err)) {
            void waitForFolderAccess(true);
        } else {
            toast.error('无法开始下载：' + (err?.message || err));
        }
    } finally {
        preparingDownload.value = false;
    }
}

async function onDownload() {
    if (!window.KrKr2Cache || !game.value?.downloadUrl) return;
    if (preparingDownload.value) return;
    const current = window.KrKr2Cache.downloadState();
    if (current?.gameKey === game.value.id) {
        await window.KrKr2Cache.stopDownload();
        downloading.value = null;
        await refreshCache();
        return;
    }
    if (cached.value) return;

    preparingDownload.value = true;
    try {
        storage.value = await window.KrKr2Cache.storageInfo();
    } catch (err) {
        preparingDownload.value = false;
        toast.error('无法读取下载位置：' + (err?.message || err));
        return;
    }
    if (storage.value?.supported && storage.value.kind !== 'folder' &&
        getSetting('downloadFolderPrompt') && !dismissedFolderPrompt.value) {
        pendingDownload.value = true;
        preparingDownload.value = false;
        return;
    }
    if (storage.value?.needsPermission) {
        preparingDownload.value = false;
        void waitForFolderAccess(true);
        return;
    }
    await beginDownload();
}

async function chooseFolder() {
    try {
        await window.KrKr2Cache.bindFolder();
        storage.value = await window.KrKr2Cache.storageInfo();
    } catch (err) {
        if (err?.name === 'AbortError') return;
        toast.error('绑定文件夹失败：' + (err?.message || err));
        return;
    }
    pendingDownload.value = false;
    await beginDownload();
}

function cancelDownloadLocation() {
    pendingDownload.value = false;
}

function openCachePermission() {
    if (folderAccess.needsPermission.value) folderAccess.prompt();
}

async function skipFolder(dontAskAgain = false) {
    dismissedFolderPrompt.value = true;
    if (dontAskAgain) setSetting('downloadFolderPrompt', false);
    pendingDownload.value = false;
    await beginDownload();
}

async function onPlay(event) {
    const current = window.KrKr2Cache?.downloadState?.();
    if (!current?.running || current.gameKey !== game.value?.id) return;
    event.preventDefault();
    requestDownloadHandoff(game.value.id);
    await window.KrKr2Cache.stopDownload();
    location.href = `/play/${encodeURIComponent(game.value.id)}`;
}

onMounted(async () => {
    const storageCheck = refreshStorage(true).catch(() => {});
    try {
        const [loadedGame, accountResult] = await Promise.all([
            api.getGame(gameId),
            api.getAccount().catch(() => ({ user: null })),
            storageCheck
        ]);
        game.value = loadedGame;
        account.value = accountResult.user || null;
        if (!game.value) loadError.value = '这个游戏不存在，或已被下架。';
        else document.title = `${game.value.title} · 游戏库`;
        await refreshCache();
    } catch (err) {
        loadError.value = err.status === 404
            ? '这个游戏不存在，或已被下架。'
            : (err.message || '无法加载游戏信息');
    } finally {
        loading.value = false;
    }
    pollTimer = setInterval(pollDownload, 700);
});

onUnmounted(() => {
    if (pollTimer) clearInterval(pollTimer);
});
</script>

<template>
    <header class="nav detail-nav">
        <BackToGallery />
        <div class="detail-nav-actions">
            <a class="btn btn-ghost btn-sm" href="/settings">设置</a>
            <AccountMenu
                :cache-warning="folderAccess.needsPermission.value"
                @open-cache="openCachePermission" />
        </div>
    </header>

    <main class="detail-body">
        <div v-if="loading" class="detail-skeleton" aria-label="正在加载" />

        <div v-else-if="loadError" class="empty detail-empty">
            <h2>无法打开作品</h2>
            <p>{{ loadError }}</p>
        </div>

        <article v-else-if="game" class="detail-layout">
            <div class="detail-cover-wrap">
                <img
                    v-if="cover"
                    class="detail-cover"
                    :src="cover"
                    :alt="game.title"
                    decoding="async"
                    @error="coverFailed = true">
                <div v-else class="detail-cover detail-cover-fallback" aria-hidden="true">{{ initial }}</div>
                <span v-if="game.pinned" class="pin">置顶</span>
            </div>

            <div class="detail-info">
                <p class="detail-eyebrow">作品</p>
                <h1 class="detail-title">{{ game.title }}</h1>

                <div v-if="game.tags?.length" class="detail-tags">
                    <span v-for="tag in game.tags" :key="tag" class="tag">{{ tag }}</span>
                </div>

                <p class="detail-description">
                    {{ game.description || '暂无简介。' }}
                </p>

                <div class="detail-actions">
                    <a
                        class="btn btn-primary detail-play"
                        :href="`/play/${encodeURIComponent(game.id)}`"
                        @click="onPlay">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="17" height="17" aria-hidden="true">
                            <path d="M8 5v14l11-7z" />
                        </svg>
                        开始游戏
                    </a>
                    <button
                        v-if="game.downloadUrl"
                        class="btn detail-download"
                        :class="{ active: !!downloading, cached }"
                        type="button"
                        :disabled="preparingDownload"
                        @click="onDownload">
                        <span v-if="preparingDownload" class="spinner detail-download-spinner" aria-hidden="true" />
                        <svg v-else-if="cached" viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true">
                            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                        </svg>
                        <svg v-else-if="downloading" viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true">
                            <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
                        </svg>
                        <svg v-else viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true">
                            <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" />
                        </svg>
                        {{ downloadLabel }}
                    </button>
                    <button class="btn detail-sync" type="button" @click="showSync = true">
                        <Cloud :size="16" aria-hidden="true" />
                        同步存档
                    </button>
                </div>

                <div v-if="preparingDownload || cacheInfo || downloading" class="detail-cache">
                    <div class="detail-cache-line">
                        <span v-if="preparingDownload">正在检查资源与本地空间，请稍候</span>
                        <span v-else-if="downloading">正在下载{{ downloading.retrying ? '，网络中断后续传' : '' }}</span>
                        <span v-else-if="cached">已完整下载到本地 · {{ fmt(cacheInfo.bytes) }}</span>
                        <span v-else>已下载 {{ fmt(cacheInfo.bytes) }} · {{ partialPct }}%</span>
                        <strong v-if="downloading">{{ downloadPct }}%</strong>
                    </div>
                    <div v-if="!preparingDownload" class="detail-progress">
                        <span :style="{ width: downloadPct + '%' }" />
                    </div>
                </div>
            </div>
        </article>

        <GameLeaderboard
            v-if="game"
            :game-id="game.id"
            :account="account" />
    </main>

    <DownloadLocationDialog
        v-if="pendingDownload"
        @cancel="cancelDownloadLocation"
        @select-folder="chooseFolder"
        @use-browser="skipFolder" />

    <SyncPanel
        v-if="showSync && game"
        :games="[game]"
        :account="account"
        @close="showSync = false" />
</template>

<style scoped>
.detail-nav-actions { display: flex; align-items: center; gap: var(--space-2); }

.detail-body {
    max-width: 1080px;
    margin: 0 auto;
    padding: var(--space-7) var(--space-5) 96px;
}

.nav {
    position: sticky;
    top: 0;
    z-index: var(--z-toolbar);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-5);
    background: rgba(10, 10, 11, 0.8);
    backdrop-filter: blur(16px);
    border-bottom: 1px solid var(--line);
}

.detail-layout {
    display: grid;
    grid-template-columns: minmax(220px, 300px) minmax(0, 1fr);
    gap: clamp(var(--space-6), 8vw, 112px);
    align-items: start;
}

.detail-cover-wrap {
    position: relative;
    width: 100%;
    max-width: 300px;
    aspect-ratio: 3 / 4;
    justify-self: center;
    background: var(--bg-2);
}

.detail-cover {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.detail-cover-fallback {
    display: grid;
    place-items: center;
    color: var(--fg-2);
    font-size: 72px;
    font-weight: 300;
    background: linear-gradient(160deg, var(--bg-2), var(--bg-1));
}

.pin {
    position: absolute;
    top: var(--space-2);
    left: var(--space-2);
    padding: 2px 7px;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.7);
    backdrop-filter: blur(8px);
    font-size: 10px;
    color: var(--fg-0);
}

.detail-info { min-width: 0; padding-top: var(--space-5); }
.detail-eyebrow {
    margin: 0 0 var(--space-2);
    color: var(--fg-2);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
}

.detail-title {
    margin: 0;
    font-size: clamp(28px, 4vw, 42px);
    line-height: 1.18;
    letter-spacing: -0.03em;
    font-weight: 650;
    overflow-wrap: anywhere;
}

.detail-tags { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-4); }

.detail-description {
    max-width: 680px;
    margin: var(--space-6) 0 0;
    color: var(--fg-1);
    font-size: 15px;
    line-height: 1.85;
    white-space: pre-line;
}

.detail-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-6); }
.detail-play { padding: 10px 18px; font-size: 14px; }
.detail-download { padding: 10px 16px; }
.detail-sync { padding: 10px 16px; }
.detail-download.active { border-color: var(--line-strong); }
.detail-download.cached { color: #6ee7a8; }
.detail-download-spinner { width: 16px; height: 16px; }

.detail-cache {
    max-width: 520px;
    margin-top: var(--space-5);
    color: var(--fg-2);
    font-size: 11px;
}

.detail-cache-line { display: flex; justify-content: space-between; gap: var(--space-3); }
.detail-cache-line strong { color: var(--fg-1); font-weight: 500; }
.detail-progress { height: 3px; margin-top: var(--space-2); background: var(--bg-3); }
.detail-progress span { display: block; height: 100%; background: var(--fg-0); transition: width 240ms var(--ease); }

.detail-skeleton {
    width: min(100%, 900px);
    height: 480px;
    margin: 0 auto;
    border-radius: var(--radius);
    background: linear-gradient(90deg, var(--bg-1) 25%, var(--bg-2) 50%, var(--bg-1) 75%);
    background-size: 200% 100%;
    animation: shimmer 1.4s infinite;
}

@keyframes shimmer { to { background-position: -200% 0; } }

.empty {
    padding: var(--space-7) var(--space-4);
    text-align: center;
    border: 1px dashed var(--line);
    border-radius: var(--radius-lg);
    background: var(--bg-1);
}

.empty h2 { margin: 0 0 var(--space-2); font-size: 17px; }
.empty p { margin: 0 auto var(--space-5); color: var(--fg-1); font-size: 13px; }
.detail-empty { max-width: 640px; margin: 0 auto; }

@media (max-width: 680px) {
    .detail-nav-actions { gap: var(--space-1); }
    .detail-nav { padding-left: var(--space-4); padding-right: var(--space-4); }
    .detail-body { padding: var(--space-5) var(--space-4) 72px; }
    .detail-layout { display: block; }
    .detail-cover-wrap { width: min(68vw, 280px); margin: 0 auto; }
    .detail-info { padding-top: var(--space-6); }
    .detail-title { font-size: 30px; }
    .detail-description { margin-top: var(--space-5); font-size: 14px; line-height: 1.75; }
    .detail-actions { margin-top: var(--space-5); }
    .detail-play { flex: 1; justify-content: center; }
    .detail-download { flex: 1; justify-content: center; }
    .detail-sync { flex: 1 0 100%; justify-content: center; }
}
</style>
