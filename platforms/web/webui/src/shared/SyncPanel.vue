<script setup>
import { computed, onMounted, ref } from 'vue';
import { accountLoginUrl } from './api.js';
import {
    classifySync,
    deleteRemoteSave,
    downloadBoth,
    getSyncBackend,
    localSaveSummary,
    resolveConflictWithCloud,
    resolveConflictWithLocal,
    restoreHistoricalRevision,
    spaceIdForGame,
    syncAllGames,
    syncGame
} from './cloudSaves.js';
import { showConfirm } from './dialog.js';
import { toast } from './toast.js';

const props = defineProps({
    games: { type: Array, default: () => [] },
    account: { type: Object, default: null },
    startImmediately: { type: Boolean, default: false }
});
const emit = defineEmits(['close']);

const loading = ref(true);
const running = ref(false);
const rows = ref([]);
const cloudUsage = ref(null);
const status = ref('');
const progress = ref('');
const conflicts = ref(new Map());
const historyGame = ref(null);
const history = ref([]);
const historyLoading = ref(false);
const backend = ref(null);
const returnTo = location.pathname + location.search;
const singleGame = computed(() => props.games.length === 1 ? props.games[0] : null);
const needsLogin = computed(() => !!backend.value?.requiresAccount && !props.account);
const canSync = computed(() => !!backend.value && !needsLogin.value);
const remoteName = computed(() => backend.value?.kind === 'webdav' ? 'WebDAV' : '站点云端');

const relevantRows = computed(() => rows.value.filter((row) => row.local || row.remote));

function fmtBytes(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1048576).toFixed(1)} MB`;
}

function fmtTime(value) {
    if (!value) return '从未同步';
    return new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).format(new Date(value));
}

function stateFor(row) {
    if (conflicts.value.has(row.game.id)) return { key: 'conflict', label: '存在冲突' };
    if (!row.local && row.remote) return { key: 'cloud', label: `仅${remoteName.value}` };
    if (row.local && !row.remote) return { key: 'dirty', label: '待首次同步' };
    if (!row.local && !row.remote) return { key: 'empty', label: '无存档' };
    const action = classifySync(
        { files: { length: row.local.count || 0 }, meta: row.local },
        row.remote,
        backend.value?.targetKey || 'site'
    );
    if (action === 'conflict') return { key: 'conflict', label: '存在冲突' };
    if (action === 'upload') return { key: 'dirty', label: '本机待同步' };
    if (action === 'download') return { key: 'cloud', label: `${remoteName.value}有更新` };
    return { key: 'synced', label: '已同步' };
}

async function refresh() {
    loading.value = true;
    backend.value = null;
    cloudUsage.value = null;
    rows.value = [];
    try {
        backend.value = getSyncBackend();
        const local = await localSaveSummary(props.games, backend.value);
        const localMap = new Map(local.map((row) => [row.game.id, row]));
        let cloud = { saves: [], usage: null };
        if (!backend.value.requiresAccount || props.account) {
            cloud = await backend.value.list(props.games);
        }
        cloudUsage.value = cloud.usage;
        const remoteMap = new Map((cloud.saves || []).map((revision) => [revision.gameId, revision]));
        rows.value = props.games.map((game) => ({
            game,
            local: localMap.get(game.id) || null,
            remote: remoteMap.get(game.id) || null
        }));
    } catch (err) {
        status.value = err.message || '读取存档状态失败';
    } finally {
        loading.value = false;
    }
}

async function runAll() {
    if (!canSync.value || running.value) return;
    running.value = true;
    status.value = '';
    progress.value = '正在检查本机与远端版本…';
    conflicts.value = new Map();
    try {
        const result = await syncAllGames(props.games, ({ index, total, game }) => {
            progress.value = `正在同步 ${index + 1} / ${total}：${game.title}`;
        }, backend.value);
        const nextConflicts = new Map();
        for (const item of result.results) {
            if (item.result === 'conflict') nextConflicts.set(item.game.id, item);
        }
        conflicts.value = nextConflicts;
        const uploaded = result.results.filter((item) => item.result === 'uploaded').length;
        const downloaded = result.results.filter((item) => item.result === 'downloaded').length;
        const unchanged = result.results.filter((item) => item.result === 'unchanged').length;
        status.value = result.results.length
            ? `完成：上传 ${uploaded}，下载 ${downloaded}，无变化 ${unchanged}` +
              (nextConflicts.size ? `，冲突 ${nextConflicts.size}` : '')
            : '没有需要同步的存档';
        await refresh();
    } catch (err) {
        status.value = err.status === 401 ? '登录已失效，请重新登录' : (err.message || '同步失败');
    } finally {
        running.value = false;
        progress.value = '';
    }
}

async function runOne(row) {
    if (running.value) return;
    running.value = true;
    status.value = `正在同步《${row.game.title}》…`;
    try {
        const cloud = await backend.value.list(props.games);
        const remote = (cloud.saves || []).find((item) => item.gameId === row.game.id) || null;
        const result = await syncGame(row.game, remote, backend.value);
        if (result.result === 'conflict') {
            const next = new Map(conflicts.value);
            next.set(row.game.id, result);
            conflicts.value = next;
            status.value = '检测到两个不同进度，请选择保留方式';
        } else {
            status.value = result.result === 'uploaded' ? '已上传本机版本'
                : result.result === 'downloaded' ? '已下载远端版本' : '存档已经是最新版本';
        }
        await refresh();
    } catch (err) {
        status.value = err.message || '同步失败';
    } finally {
        running.value = false;
    }
}

async function resolve(row, choice) {
    const conflictState = conflicts.value.get(row.game.id) || {
        game: row.game,
        remote: row.remote,
        spaceId: spaceIdForGame(row.game.id),
        backend: backend.value
    };
    if (!conflictState.remote || running.value) return;
    if (choice !== 'both') {
        const message = choice === 'local'
            ? '确定使用本机版本？当前远端版本会保留在历史中。'
            : '确定使用远端版本？本机未同步的进度会被替换；需要保留时请先选择“下载两份”。';
        const ok = await showConfirm({
            title: '解决存档冲突',
            message,
            confirmText: choice === 'local' ? '使用本机版本' : '使用远端版本',
            danger: choice === 'cloud'
        });
        if (!ok) return;
    }
    running.value = true;
    try {
        if (choice === 'local') await resolveConflictWithLocal(conflictState);
        if (choice === 'cloud') await resolveConflictWithCloud(conflictState);
        if (choice === 'both') await downloadBoth(conflictState);
        if (choice !== 'both') {
            const next = new Map(conflicts.value);
            next.delete(row.game.id);
            conflicts.value = next;
            status.value = `《${row.game.title}》冲突已处理`;
            await refresh();
        } else {
            status.value = '本机与远端 ZIP 均已下载，冲突仍保留等待选择';
        }
    } catch (err) {
        status.value = err.message || '处理冲突失败';
    } finally {
        running.value = false;
    }
}

async function openHistory(row) {
    historyGame.value = row.game;
    history.value = [];
    historyLoading.value = true;
    try { history.value = await backend.value.history(row.game.id); }
    catch (err) { status.value = err.message || '读取历史失败'; }
    finally { historyLoading.value = false; }
}

async function restore(revision) {
    if (!historyGame.value || running.value) return;
    const ok = await showConfirm({
        title: '恢复历史版本',
        message: '恢复这个历史版本？它会成为新的最新版本，并替换本机存档。',
        confirmText: '恢复此版本',
        danger: true
    });
    if (!ok) return;
    running.value = true;
    try {
        await restoreHistoricalRevision(historyGame.value, revision.id, backend.value);
        status.value = '历史版本已恢复为最新版本';
        toast.success('历史版本已恢复为最新版本');
        historyGame.value = null;
        await refresh();
    } catch (err) {
        status.value = err.message || '恢复失败';
        toast.error(err.message || '恢复失败');
    } finally {
        running.value = false;
    }
}

async function deleteRemote(row) {
    if (running.value) return;
    const ok = await showConfirm({
        title: '删除云端存档',
        message: `确定清空《${row.game.title}》在 ${remoteName.value} 上的所有存档与历史版本？\n（本机已有的存档不会被删除）`,
        confirmText: '清空云端存档',
        danger: true
    });
    if (!ok) return;
    running.value = true;
    try {
        await deleteRemoteSave(row.game.id, backend.value);
        toast.success(`《${row.game.title}》的 ${remoteName.value} 存档已清空`);
        if (historyGame.value?.id === row.game.id) historyGame.value = null;
        await refresh();
    } catch (err) {
        toast.error(err.message || '删除远端存档失败');
    } finally {
        running.value = false;
    }
}

onMounted(async () => {
    await refresh();
    if (props.startImmediately && canSync.value) await runAll();
});
</script>

<template>
    <Teleport to="body">
        <div class="sync-backdrop" @click.self="emit('close')">
            <section class="sync-panel" role="dialog" aria-modal="true" aria-labelledby="sync-title">
                <header class="sync-head">
                    <div>
                        <h2 id="sync-title">{{ singleGame ? `${singleGame.title} · 存档同步` : '存档同步' }}</h2>
                        <p>仅在你点击同步时传输存档，不会在游玩过程中自动上传。</p>
                    </div>
                    <button class="btn btn-ghost btn-sm" @click="emit('close')">关闭</button>
                </header>

                <div v-if="needsLogin" class="sync-login">
                    <strong>登录后才能同步</strong>
                    <p>当前选择的是站点云存档。可使用任一账号登录；WebDAV 无需本站账号，可在设置中切换。</p>
                    <div class="sync-login-actions">
                        <a class="btn btn-primary" :href="accountLoginUrl('steam', { returnTo })">使用 Steam 登录</a>
                        <a class="btn" :href="accountLoginUrl('github', { returnTo })">使用 GitHub 登录</a>
                        <a class="btn btn-ghost" href="/settings">改用 WebDAV</a>
                    </div>
                </div>

                <div v-else-if="!backend" class="sync-login">
                    <strong>WebDAV 尚未配置</strong>
                    <p>{{ status || '请先填写 WebDAV 地址、用户名和密码。' }}</p>
                    <a class="btn btn-primary" href="/settings">前往设置</a>
                </div>

                <template v-else>
                    <div class="sync-toolbar">
                        <div>
                            <strong>{{ backend.label }}</strong>
                            <span v-if="backend.kind === 'site' && account">{{ account.displayName }}</span>
                            <span v-if="cloudUsage">站点云端 {{ fmtBytes(cloudUsage.bytes) }} / {{ fmtBytes(cloudUsage.limit) }}</span>
                            <span v-else-if="backend.kind === 'webdav'">存档直接传输到你的 WebDAV</span>
                        </div>
                        <button class="btn btn-primary" :disabled="running" @click="runAll">
                            <span v-if="running" class="spinner" />
                            {{ running ? '同步中' : (singleGame ? '同步这个游戏' : '同步全部存档') }}
                        </button>
                    </div>

                    <div v-if="loading" class="sync-loading"><span class="spinner" /></div>
                    <p v-else-if="relevantRows.length === 0" class="sync-empty">本机和远端都还没有存档。</p>
                    <ul v-else class="sync-list">
                        <li v-for="row in relevantRows" :key="row.game.id" class="sync-row">
                            <div class="sync-info">
                                <strong>{{ row.game.title }}</strong>
                                <span>
                                    {{ row.local ? `${row.local.count} 个本地文件 · ${fmtBytes(row.local.size)}` : '本机无存档' }}
                                    <template v-if="row.remote"> · {{ remoteName }} {{ fmtTime(row.remote.createdAt) }}</template>
                                </span>
                            </div>
                            <span class="sync-state" :class="stateFor(row).key">{{ stateFor(row).label }}</span>
                            <div class="sync-actions">
                                <template v-if="stateFor(row).key === 'conflict'">
                                    <button class="btn btn-sm" :disabled="running" @click="resolve(row, 'cloud')">使用远端</button>
                                    <button class="btn btn-sm" :disabled="running" @click="resolve(row, 'local')">使用本机</button>
                                    <button class="btn btn-ghost btn-sm" :disabled="running" @click="resolve(row, 'both')">下载两份</button>
                                </template>
                                <button v-else class="btn btn-sm" :disabled="running" @click="runOne(row)">同步</button>
                                <button v-if="row.remote" class="btn btn-ghost btn-sm" :disabled="running" @click="openHistory(row)">历史</button>
                                <button v-if="row.remote" class="btn btn-ghost btn-sm btn-danger" :disabled="running" title="删除远端云存档" @click="deleteRemote(row)">清空云端</button>
                            </div>
                        </li>
                    </ul>
                </template>

                <footer v-if="status || progress" class="sync-status" aria-live="polite">
                    {{ progress || status }}
                </footer>

                <div v-if="historyGame" class="history-layer" @click.self="historyGame = null">
                    <section class="history-panel">
                        <header>
                            <div><h3>{{ historyGame.title }}</h3><p>最近 {{ history.length }} 个远端版本</p></div>
                            <div class="history-head-actions">
                                <button class="btn btn-danger btn-sm" :disabled="running" @click="deleteRemote({ game: historyGame })">清空云端</button>
                                <button class="btn btn-ghost btn-sm" @click="historyGame = null">返回</button>
                            </div>
                        </header>
                        <div v-if="historyLoading" class="sync-loading"><span class="spinner" /></div>
                        <ol v-else class="history-list">
                            <li v-for="(revision, index) in history" :key="revision.id">
                                <div>
                                    <strong>{{ index === 0 ? '当前版本' : fmtTime(revision.createdAt) }}</strong>
                                    <span>{{ revision.deviceName }} · {{ revision.fileCount }} 个文件 · {{ fmtBytes(revision.byteSize) }}</span>
                                </div>
                                <button v-if="index > 0" class="btn btn-sm" :disabled="running" @click="restore(revision)">恢复</button>
                            </li>
                        </ol>
                    </section>
                </div>
            </section>
        </div>
    </Teleport>
</template>

<style scoped>
.sync-backdrop { position: fixed; inset: 0; z-index: var(--z-modal); display: grid; place-items: center; padding: 16px; background: rgba(0,0,0,.74); backdrop-filter: blur(8px); }
.sync-panel { position: relative; width: min(820px, 100%); max-height: min(760px, 90vh); display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--line-strong); border-radius: var(--radius); background: var(--bg-1); box-shadow: var(--shadow-lg); }
.sync-head { display: flex; justify-content: space-between; gap: 20px; padding: 20px; border-bottom: 1px solid var(--line); }
.sync-head h2, .history-panel h3 { margin: 0 0 5px; font-size: 17px; }
.sync-head p, .history-panel p, .sync-login p { margin: 0; color: var(--fg-2); font-size: 12px; line-height: 1.6; }
.sync-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 20px; border-bottom: 1px solid var(--line); background: var(--bg-2); }
.sync-toolbar > div { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.sync-toolbar strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.sync-toolbar span { color: var(--fg-2); font-size: 11px; }
.sync-list, .history-list { list-style: none; margin: 0; padding: 0; overflow: auto; }
.sync-row { display: grid; grid-template-columns: minmax(180px, 1fr) auto auto; align-items: center; gap: 14px; min-height: 68px; padding: 12px 20px; border-bottom: 1px solid var(--line); }
.sync-info { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.sync-info strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.sync-info span { color: var(--fg-2); font-size: 11px; }
.sync-state { min-width: 72px; font-size: 11px; text-align: center; color: var(--fg-2); }
.sync-state.dirty, .sync-state.cloud { color: var(--accent); }
.sync-state.conflict { color: var(--danger); }
.sync-state.synced { color: #65c18c; }
.sync-actions { display: flex; justify-content: flex-end; gap: 6px; flex-wrap: wrap; }
.sync-loading, .sync-empty { min-height: 160px; display: grid; place-items: center; color: var(--fg-2); font-size: 12px; }
.sync-status { min-height: 42px; padding: 12px 20px; border-top: 1px solid var(--line); color: var(--fg-1); font-size: 12px; }
.sync-login { padding: 32px 20px; }
.sync-login strong { font-size: 15px; }
.sync-login p { margin: 8px 0 18px; max-width: 520px; }
.sync-login-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.history-layer { position: absolute; inset: 0; display: grid; place-items: center; padding: 16px; background: rgba(0,0,0,.66); }
.history-panel { width: min(560px, 100%); max-height: 80%; overflow: hidden; display: flex; flex-direction: column; border: 1px solid var(--line-strong); border-radius: var(--radius-sm); background: var(--bg-1); box-shadow: var(--shadow-lg); }
.history-panel > header { display: flex; justify-content: space-between; gap: 16px; padding: 16px; border-bottom: 1px solid var(--line); }
.history-head-actions { display: flex; align-items: center; gap: 8px; }
.history-list li { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 58px; padding: 10px 16px; border-bottom: 1px solid var(--line); }
.history-list li > div { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.history-list strong { font-size: 12px; }
.history-list span { color: var(--fg-2); font-size: 11px; }
@media (max-width: 680px) {
    .sync-backdrop { padding: 0; align-items: end; }
    .sync-panel { width: 100%; max-height: 92dvh; border-radius: var(--radius) var(--radius) 0 0; }
    .sync-row { grid-template-columns: 1fr auto; gap: 8px; padding: 12px 14px; }
    .sync-actions { grid-column: 1 / -1; justify-content: flex-start; }
    .sync-head, .sync-toolbar { padding-left: 14px; padding-right: 14px; }
}
</style>
