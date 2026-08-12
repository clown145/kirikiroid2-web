<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { api } from '../shared/api.js';
import AccountMenu from '../shared/AccountMenu.vue';
import SyncPanel from '../shared/SyncPanel.vue';
import { localSaveSummary } from '../shared/cloudSaves.js';
import { getSetting } from '../shared/settings.js';
import GameCard from './GameCard.vue';

const games = ref([]);
const loading = ref(true);
const loadError = ref('');
const search = ref('');
const activeTag = ref('');
const account = ref(null);
const showSync = ref(false);
const syncImmediately = ref(false);
const dirtySaveCount = ref(0);

const allTags = computed(() => {
    const counts = new Map();
    for (const g of games.value) {
        for (const t of g.tags) counts.set(t, (counts.get(t) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
});

const filtered = computed(() => {
    const q = search.value.trim().toLowerCase();
    return games.value.filter((g) => {
        if (activeTag.value && !g.tags.includes(activeTag.value)) return false;
        if (!q) return true;
        return (
            g.title.toLowerCase().includes(q) ||
            g.description.toLowerCase().includes(q) ||
            g.tags.some((t) => t.toLowerCase().includes(q))
        );
    });
});

// 库里一个游戏都没有 vs 有游戏但筛没了 —— 两种空状态的引导完全不同
const isEmptyLibrary = computed(() => !loading.value && games.value.length === 0);

// --- 缓存与预下载 -----------------------------------------------------
// 画廊页不加载引擎，这些能力全部来自 public/js/storage/*（window.KrKr2Cache）。
const cacheMap = ref({});          // gameKey -> {bytes, size, complete}
const dlState = ref(null);         // 当前下载 {gameKey, pct, running, done}
const usage = ref(null);
const showCachePanel = ref(false);
const pendingNav = ref(null);      // 有下载在跑时被拦下的跳转
const pendingDownload = ref(null); // 等待"存哪里"决定的下载
const storage = ref(null);         // {kind, name, supported, bound, needsPermission}
const dismissedFolderPrompt = ref(false);
let dlPoll = null;

async function refreshCache() {
    if (!window.KrKr2Cache) return;
    try {
        const list = await window.KrKr2Cache.list();
        const map = {};
        for (const g of list) map[g.gameKey] = g;
        cacheMap.value = map;
    } catch { /* 缓存不可用时画廊照常工作 */ }
}

async function refreshUsage() {
    if (!window.KrKr2Cache) return;
    try { usage.value = await window.KrKr2Cache.usage(); } catch {}
}

function pollDownload() {
    dlState.value = window.KrKr2Cache?.downloadState?.() || null;
    if (dlState.value?.done) {
        refreshCache();
        dlState.value = null;
        window.KrKr2Cache?.stopDownload();
    }
}

async function onDownload(game) {
    if (!window.KrKr2Cache) return;
    const cur = window.KrKr2Cache.downloadState();
    // 再点正在下的那个 = 停止（进度已落盘，下次续传）
    if (cur && cur.gameKey === game.id) {
        await window.KrKr2Cache.stopDownload();
        dlState.value = null;
        await refreshCache();
        return;
    }
    if (cacheMap.value[game.id]?.complete) {
        showCachePanel.value = true;   // 已下完，改为引导去管理
        await refreshUsage();
        return;
    }

    // 首次完整下载先问存哪：点这个按钮本身就是"我要长期留着"的意思，
    // 而 OPFS 存不住几个 GB —— 浏览器在存储压力下会清掉它。
    storage.value = await window.KrKr2Cache.storageInfo();
    if (storage.value.supported && storage.value.kind !== 'folder' &&
        !dismissedFolderPrompt.value) {
        pendingDownload.value = game;
        return;
    }
    await beginDownload(game);
}

async function beginDownload(game) {
    try {
        // 一次只下一个：并行下两个只会都变慢，还抢光连接
        await window.KrKr2Cache.download({
            gameKey: game.id,
            title: game.title,
            url: (game.downloadUrl || '').trim(),
            onDone: () => { refreshCache(); },
            onError: (error) => {
                const message = error?.message || String(error || '未知错误');
                window.KrKr2Cache.stopDownload().finally(async () => {
                    dlState.value = null;
                    await refreshCache();
                    alert('下载已停止：' + message);
                });
            }
        });
        pollDownload();
    } catch (err) {
        alert('无法开始下载：' + (err?.message || err));
    }
}

/** 用户在引导框里选了「选择文件夹」。必须在手势里调用才能弹选择器。 */
async function chooseFolder() {
    try {
        await window.KrKr2Cache.bindFolder();
        storage.value = await window.KrKr2Cache.storageInfo();
    } catch (err) {
        if (err?.name === 'AbortError') return;    // 用户取消了选择器
        alert('绑定文件夹失败：' + (err?.message || err));
        return;
    }
    const game = pendingDownload.value;
    pendingDownload.value = null;
    if (game) await beginDownload(game);
}

/** 选择「暂不，存浏览器里」。本次会话不再追问。 */
async function skipFolder() {
    dismissedFolderPrompt.value = true;
    const game = pendingDownload.value;
    pendingDownload.value = null;
    if (game) await beginDownload(game);
}

async function onNavigate(game, event) {
    const current = window.KrKr2Cache?.downloadState?.();
    if (!current?.running) return;
    event.preventDefault();
    const href = `/game/${encodeURIComponent(game.id)}`;

    if (current.gameKey === game.id) {
        // 详情页仍是独立导航，先提交当前连续前缀；真正进入播放器时
        // 再由详情页写入 download handoff，避免只看详情也启动边玩边下。
        await window.KrKr2Cache.stopDownload();
        location.href = href;
        return;
    }

    pendingNav.value = { game, href };
}

async function confirmNav() {
    const href = pendingNav.value?.href;
    await window.KrKr2Cache?.stopDownload();      // 提交连续前缀再走
    pendingNav.value = null;
    if (href) location.href = href;
}

async function stopCurrentDownload() {
    await window.KrKr2Cache?.stopDownload();
    dlState.value = null;
    await refreshCache();
}

async function removeCache(gameKey) {
    await window.KrKr2Cache?.remove(gameKey);
    await refreshCache();
    await refreshUsage();
}

async function removeAllCache() {
    if (!confirm('清空所有游戏的本地缓存？下次游玩需要重新下载。')) return;
    await window.KrKr2Cache?.removeAll();
    dlState.value = null;
    await refreshCache();
    await refreshUsage();
}

async function openCachePanel() {
    showCachePanel.value = true;
    storage.value = await window.KrKr2Cache?.storageInfo();
    await refreshUsage();
    await refreshCache();
}

/** 在缓存面板里切换/恢复存储位置。 */
async function bindFolderFromPanel() {
    try {
        await window.KrKr2Cache.bindFolder();
    } catch (err) {
        if (err?.name !== 'AbortError') alert('绑定失败：' + (err?.message || err));
    }
    storage.value = await window.KrKr2Cache.storageInfo();
    await refreshCache();
    await refreshUsage();
}

async function unbindFolderFromPanel() {
    if (!confirm('不再使用该文件夹？已下载的文件会留在磁盘上，不会被删除。')) return;
    await window.KrKr2Cache.unbindFolder();
    storage.value = await window.KrKr2Cache.storageInfo();
    dlState.value = null;
    await refreshCache();
    await refreshUsage();
}

function fmtBytes(bytes) {
    if (!bytes) return '0 MB';
    const mb = bytes / 1048576;
    return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB';
}

const cachedList = computed(() =>
    Object.values(cacheMap.value).sort((a, b) => b.bytes - a.bytes));

function toggleTag(tag) {
    activeTag.value = activeTag.value === tag ? '' : tag;
}

function clearFilters() {
    search.value = '';
    activeTag.value = '';
}

function openSync(start = false) {
    syncImmediately.value = start;
    showSync.value = true;
}

async function closeSync() {
    showSync.value = false;
    syncImmediately.value = false;
    if (!getSetting('saveSyncReminder')) return;
    try {
        const local = await localSaveSummary(games.value);
        dirtySaveCount.value = local.filter((row) => row.dirty).length;
    } catch {}
}

onMounted(async () => {
    try {
        games.value = await api.listGames();
    } catch (err) {
        loadError.value = err.message || '加载失败';
    } finally {
        loading.value = false;
    }
    try {
        const result = await api.getAccount();
        account.value = result.user || null;
        if (getSetting('saveSyncReminder')) {
            const local = await localSaveSummary(games.value);
            dirtySaveCount.value = local.filter((row) => row.dirty).length;
        }
    } catch {}
    await refreshCache();
    dlPoll = setInterval(pollDownload, 700);
});

onUnmounted(() => {
    if (dlPoll) clearInterval(dlPoll);
});
</script>

<template>
    <header class="nav">
        <a class="brand" href="/">
            <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20" aria-hidden="true">
                <path d="M21 6H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-10 7H8v3H6v-3H3v-2h3V8h2v3h3v2zm4.5 2c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm3-3c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z" />
            </svg>
            <span>Kirikiroid2</span>
        </a>

        <div class="nav-right">
            <button class="btn btn-primary btn-sm nav-sync" @click="openSync(true)">
                <span class="nav-sync-wide">同步全部存档</span><span class="nav-sync-short">同步</span>
            </button>
            <AccountMenu cache-tools @open-cache="openCachePanel" />
        </div>
    </header>

    <main class="body">
        <button v-if="dirtySaveCount" class="save-reminder" @click="openSync(false)">
            <span>{{ dirtySaveCount }} 个游戏有本地存档待同步</span>
            <strong>查看</strong>
        </button>
        <div class="head">
            <div>
                <h1 class="h1">游戏库</h1>
                <p class="count" v-if="!loading">
                    {{ filtered.length }}<template v-if="filtered.length !== games.length"> / {{ games.length }}</template> 个游戏
                </p>
            </div>

            <label class="search" v-if="games.length">
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true">
                    <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
                </svg>
                <input v-model="search" type="search" placeholder="搜索标题、简介或标签" aria-label="搜索游戏">
            </label>
        </div>

        <div class="tagbar" v-if="allTags.length">
            <button
                v-for="tag in allTags"
                :key="tag"
                class="tag-btn"
                :class="{ active: activeTag === tag }"
                @click="toggleTag(tag)">
                {{ tag }}
            </button>
        </div>

        <!-- 骨架屏：保持与真实卡片相同的宽高比，避免加载完成时布局跳动 -->
        <div v-if="loading" class="grid">
            <div v-for="n in 10" :key="n" class="skeleton" />
        </div>

        <div v-else-if="loadError" class="empty">
            <h2>加载失败</h2>
            <p>{{ loadError }}</p>
            <button class="btn" @click="() => location.reload()">重试</button>
        </div>

        <!-- 空库：首次部署的正常状态，引导去后台 -->
        <div v-else-if="isEmptyLibrary" class="empty">
            <h2>游戏库还是空的</h2>
            <p>到管理后台添加第一个游戏，或直接打开本地的 .xp3 / .zip 文件试玩。</p>
            <div class="empty-actions">
                <a class="btn btn-primary" href="/admin">前往管理后台</a>
                <a class="btn" href="/play/local">打开本地文件</a>
            </div>
        </div>

        <!-- 有库但筛空了 -->
        <div v-else-if="filtered.length === 0" class="empty">
            <h2>没有匹配的游戏</h2>
            <p>换个关键词，或清除当前筛选条件。</p>
            <button class="btn" @click="clearFilters">清除筛选</button>
        </div>

        <div v-else class="grid">
            <GameCard
                v-for="game in filtered"
                :key="game.id"
                :game="game"
                :cache-info="cacheMap[game.id] || null"
                :downloading="dlState && dlState.gameKey === game.id ? dlState : null"
                @download="onDownload(game)"
                @navigate="(e) => onNavigate(game, e)" />
        </div>
    </main>

    <!-- 下载中的状态条。常驻可见，玩家才知道后台在跑什么、离开会怎样。 -->
    <div v-if="dlState && dlState.running" class="dlbar">
        <div class="dlbar-in">
            <span class="dlbar-txt">
                {{ dlState.retrying
                    ? '网络中断，正在自动续传'
                    : (dlState.finalizing ? '下载完成，正在写入磁盘' : '正在下载') }}
                <strong>{{ dlState.title || dlState.gameKey }}</strong>
                · {{ dlState.pct }}%（{{ fmtBytes(dlState.bytes) }} / {{ fmtBytes(dlState.size) }}）
            </span>
            <span class="dlbar-hint">进入当前游戏会接着下载，离开本站会暂停</span>
            <button class="btn btn-sm" @click="stopCurrentDownload">停止</button>
        </div>
        <div class="dlbar-track"><span :style="{ width: dlState.pct + '%' }" /></div>
    </div>

    <!-- 正在下载别的游戏时才确认；进入当前游戏会自动交接，不弹框。 -->
    <div v-if="pendingNav" class="modal" @click.self="pendingNav = null">
        <div class="modal-box">
            <h3>下载将暂停</h3>
            <p>
                《{{ dlState?.title || '当前游戏' }}》已下载 {{ dlState?.pct ?? 0 }}%。
                打开作品详情会离开本页，后台下载随之暂停 —— 已下载的部分保留在本地，
                下次继续时从中断处接着下，不会从头再来。
            </p>
            <div class="modal-actions">
                <button class="btn" @click="pendingNav = null">留在本页</button>
                <button class="btn btn-primary" @click="confirmNav">仍然打开详情</button>
            </div>
        </div>
    </div>

    <!-- 存哪里：点「完整下载」时问一次。这是唯一能让几个 GB 真正留住的入口 -->
    <div v-if="pendingDownload" class="modal" @click.self="pendingDownload = null">
        <div class="modal-box">
            <h3>把游戏存到哪里？</h3>
            <p>
                选一个自己的文件夹，下载的游戏就是磁盘上的普通文件 ——
                浏览器永远不会自动清除，你也能直接拷走或备份。下完之后那个
                文件就是完整可用的游戏包。
            </p>
            <p class="warn">
                存在浏览器内部则无需授权，但它是临时存储：设备空间紧张时
                系统可能把它清掉，清理浏览数据也会一并删除。几个 GB 的游戏
                不建议放那里。
            </p>
            <div class="modal-actions">
                <button class="btn" @click="skipFolder">暂不，存浏览器里</button>
                <button class="btn btn-primary" @click="chooseFolder">选择文件夹</button>
            </div>
        </div>
    </div>

    <!-- 缓存管理：分游戏清理 -->
    <div v-if="showCachePanel" class="modal" @click.self="showCachePanel = false">
        <div class="modal-box wide">
            <h3>本地缓存</h3>

            <div v-if="storage" class="storage-row">
                <span>
                    存储位置：
                    <strong v-if="storage.kind === 'folder'">{{ storage.name }}</strong>
                    <strong v-else>浏览器内部存储</strong>
                    <em v-if="storage.kind !== 'folder'">（可能被系统清除）</em>
                    <em v-if="storage.needsPermission">（授权已过期，点右侧恢复）</em>
                </span>
                <button
                    v-if="storage.supported"
                    class="btn btn-ghost btn-sm"
                    @click="bindFolderFromPanel">
                    {{ storage.kind === 'folder' ? '更换' : (storage.needsPermission ? '恢复访问' : '选择文件夹') }}
                </button>
                <button
                    v-if="storage.kind === 'folder'"
                    class="btn btn-ghost btn-sm"
                    @click="unbindFolderFromPanel">
                    解除
                </button>
            </div>

            <p v-if="usage" class="usage">
                已占用 {{ fmtBytes(usage.totalBytes) }}
                <template v-if="usage.limit && isFinite(usage.limit)">
                    / 上限 {{ fmtBytes(usage.limit) }}
                </template>
                <template v-if="usage.zipBytes">（其中解压产物 {{ fmtBytes(usage.zipBytes) }}）</template>
            </p>
            <p class="usage note">
                超出上限时，最久没玩的游戏会被整个清除。绑定文件夹后不受此限制。
            </p>

            <ul v-if="cachedList.length" class="cache-list">
                <li v-for="c in cachedList" :key="c.gameKey">
                    <span class="cl-title">{{ c.title || c.gameKey }}</span>
                    <span class="cl-size">
                        {{ fmtBytes(c.bytes) }}
                        <template v-if="c.complete"> · 完整</template>
                    </span>
                    <button class="btn btn-ghost btn-sm" @click="removeCache(c.gameKey)">清理</button>
                </li>
            </ul>
            <p v-else class="usage">还没有缓存任何游戏。</p>

            <div class="modal-actions">
                <button v-if="cachedList.length" class="btn" @click="removeAllCache">全部清理</button>
                <button class="btn btn-primary" @click="showCachePanel = false">关闭</button>
            </div>
        </div>
    </div>

    <SyncPanel
        v-if="showSync"
        :games="games"
        :account="account"
        :start-immediately="syncImmediately"
        @close="closeSync" />
</template>

<style scoped>
.save-reminder {
    width: 100%;
    min-height: 42px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 18px;
    padding: 9px 12px;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    background: var(--bg-2);
    color: var(--fg-1);
    font-size: 12px;
    text-align: left;
}
.save-reminder:hover { background: var(--bg-3); }
.save-reminder strong { color: var(--accent); font-size: 11px; }
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

.brand {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.01em;
}

.brand svg { color: var(--fg-1); }

.nav-right { display: flex; align-items: center; gap: var(--space-2); }
.nav-sync-short { display: none; }

.body {
    max-width: 1400px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-5) var(--space-7);
}

.head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
    margin-bottom: var(--space-5);
}

.h1 {
    margin: 0;
    font-size: 26px;
    font-weight: 600;
    letter-spacing: -0.02em;
}

.count { margin: 6px 0 0; font-size: 13px; color: var(--fg-1); }

.search {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-3);
    min-width: 260px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--bg-1);
    color: var(--fg-2);
    transition: border-color var(--dur) var(--ease);
}

.search:focus-within { border-color: var(--line-strong); }

.search input {
    flex: 1;
    padding: 9px 0;
    border: none;
    background: none;
    outline: none;
    font-size: 13px;
    color: var(--fg-0);
}

.search input::placeholder { color: var(--fg-2); }
.search input::-webkit-search-cancel-button { filter: invert(0.6); }

.tagbar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-bottom: var(--space-5);
}

.tag-btn {
    padding: 4px 11px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--bg-1);
    font-size: 12px;
    color: var(--fg-1);
    transition: background var(--dur) var(--ease),
                color var(--dur) var(--ease),
                border-color var(--dur) var(--ease);
}

.tag-btn:hover { border-color: var(--line-strong); color: var(--fg-0); }

.tag-btn.active {
    background: var(--fg-0);
    border-color: transparent;
    color: var(--bg-0);
}

.grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    gap: var(--space-4);
}

.skeleton {
    aspect-ratio: 3 / 4.7;   /* 封面 3:4 加下方元信息区 */
    border-radius: var(--radius);
    background: linear-gradient(90deg, var(--bg-1) 25%, var(--bg-2) 50%, var(--bg-1) 75%);
    background-size: 200% 100%;
    animation: shimmer 1.4s infinite;
}

@keyframes shimmer {
    to { background-position: -200% 0; }
}

.empty {
    text-align: center;
    padding: var(--space-7) var(--space-4);
    border: 1px dashed var(--line);
    border-radius: var(--radius-lg);
    background: var(--bg-1);
}

.empty h2 {
    margin: 0 0 var(--space-2);
    font-size: 17px;
    font-weight: 600;
}

.empty p {
    margin: 0 auto var(--space-5);
    max-width: 420px;
    font-size: 13px;
    line-height: 1.65;
    color: var(--fg-1);
}

.empty-actions {
    display: flex;
    gap: var(--space-2);
    justify-content: center;
    flex-wrap: wrap;
}

@media (max-width: 640px) {
    .nav { padding: var(--space-3) var(--space-4); }
    .brand span { display: none; }
    .nav-right { gap: var(--space-1); }
    .nav-sync-wide { display: none; }
    .nav-sync-short { display: inline; }
    .body { padding: var(--space-5) var(--space-4) var(--space-6); }
    .search { min-width: 0; width: 100%; }
    .grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: var(--space-3); }
    .h1 { font-size: 22px; }
}

/* --- 下载状态条：贴底常驻，玩家得随时知道后台在跑什么 --- */
.dlbar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: var(--z-toolbar);
    background: rgba(10, 10, 11, 0.94);
    backdrop-filter: blur(16px);
    border-top: 1px solid var(--line);
}

.dlbar-in {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-5);
    font-size: 12px;
}

.dlbar-txt { color: var(--fg-0); }
.dlbar-hint { color: var(--fg-2); margin-left: auto; }
.dlbar-track { height: 2px; background: rgba(255, 255, 255, 0.1); }
.dlbar-track span {
    display: block;
    height: 100%;
    background: var(--fg-0);
    transition: width 240ms var(--ease);
}

/* --- 模态 --- */
.modal {
    position: fixed;
    inset: 0;
    z-index: var(--z-modal, 100);
    display: grid;
    place-items: center;
    padding: var(--space-4);
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(4px);
}

.modal-box {
    width: min(440px, 100%);
    max-height: 80vh;
    overflow-y: auto;
    padding: var(--space-4);
    background: var(--bg-1);
    border: 1px solid var(--line);
    border-radius: var(--radius);
}

.modal-box.wide { width: min(560px, 100%); }
.modal-box h3 { margin: 0 0 var(--space-2); font-size: 15px; }
.modal-box p {
    margin: 0 0 var(--space-3);
    font-size: 13px;
    line-height: 1.6;
    color: var(--fg-1);
}

.modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    margin-top: var(--space-3);
}

.usage { font-size: 12px; color: var(--fg-1); }
.usage.note { color: var(--fg-2); font-size: 11px; }

.warn {
    padding: var(--space-2);
    border-radius: 6px;
    background: rgba(255, 180, 60, 0.08);
    border: 1px solid rgba(255, 180, 60, 0.2);
    font-size: 12px !important;
}

.storage-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    margin-bottom: var(--space-3);
    padding-bottom: var(--space-3);
    border-bottom: 1px solid var(--line);
    font-size: 12px;
    color: var(--fg-1);
}

.storage-row > span { flex: 1; min-width: 0; }
.storage-row strong { color: var(--fg-0); font-weight: 600; }
.storage-row em { color: var(--fg-2); font-style: normal; }

.cache-list {
    list-style: none;
    margin: 0 0 var(--space-2);
    padding: 0;
    border-top: 1px solid var(--line);
}

.cache-list li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--line);
    font-size: 13px;
}

.cl-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.cl-size { flex: none; font-size: 11px; color: var(--fg-2); }

@media (max-width: 640px) {
    .dlbar-in { flex-wrap: wrap; gap: var(--space-2); }
    .dlbar-hint { margin-left: 0; width: 100%; }
}
</style>
