<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { Trophy, Users, Flame, Clock, X, EyeOff, Gamepad2 } from '@lucide/vue';
import { api, coverSrc } from './api.js';
import { getSetting, setSetting } from './settings.js';
import { toast } from './toast.js';
import Switch from './Switch.vue';

const props = defineProps({
    account: { type: Object, default: null }
});
const emit = defineEmits(['close']);

const activeTab = ref('users'); // 'users' | 'games'
const loading = ref(true);
const error = ref('');
const userList = ref([]);
const gameList = ref([]);
const uploadPlaytime = ref(getSetting('uploadPlaytime', false));

function onTogglePlaytime(checked) {
    uploadPlaytime.value = checked;
    setSetting('uploadPlaytime', checked);
    if (checked) {
        toast.success('已开启游玩时长记录与排行同步');
    } else {
        toast.info('已关闭游玩时长同步（不再向云端上报数据）');
    }
}

function fmtPlaytime(seconds) {
    if (!seconds || seconds <= 0) return { val: '0', unit: 'm' };
    const mins = Math.floor(seconds / 60);
    if (mins < 60) return { val: String(Math.max(1, mins)), unit: 'm' };
    const hours = (seconds / 3600).toFixed(1);
    return { val: hours, unit: 'h' };
}

function formatRank(rank) {
    return rank < 10 ? `0${rank}` : String(rank);
}

function getInitial(name) {
    return (name || '?').trim().charAt(0).toUpperCase();
}

async function loadData() {
    loading.value = true;
    error.value = '';
    try {
        const res = await api.getGlobalLeaderboard(activeTab.value);
        if (activeTab.value === 'users') {
            userList.value = res.list || [];
        } else {
            gameList.value = res.list || [];
        }
    } catch (err) {
        error.value = err.message || '加载排行榜数据失败';
    } finally {
        loading.value = false;
    }
}

watch(activeTab, () => {
    loadData();
});

onMounted(() => {
    loadData();
    const handleKeydown = (e) => {
        if (e.key === 'Escape') emit('close');
    };
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
});
</script>

<template>
    <Teleport to="body">
        <div class="lb-backdrop" @click.self="emit('close')">
            <section class="lb-panel" role="dialog" aria-modal="true" aria-labelledby="lb-dialog-title">
                <!-- 头部 -->
                <header class="lb-head">
                    <div class="lb-head-text">
                        <div class="lb-title-wrap">
                            <Trophy class="title-icon" :size="18" aria-hidden="true" />
                            <h2 id="lb-dialog-title">社区排行榜</h2>
                        </div>
                        <p>全站玩家游玩数据与作品热度统计</p>
                    </div>
                    <button type="button" class="btn btn-ghost btn-sm btn-icon" aria-label="关闭" @click="emit('close')">
                        <X :size="16" aria-hidden="true" />
                    </button>
                </header>

                <!-- Tab 切换与快捷设置 -->
                <div class="lb-tabs-bar">
                    <div class="lb-tabs" role="tablist">
                        <button
                            type="button"
                            role="tab"
                            class="tab-btn"
                            :class="{ active: activeTab === 'users' }"
                            :aria-selected="activeTab === 'users'"
                            @click="activeTab = 'users'">
                            <Users :size="14" aria-hidden="true" />
                            <span>玩家总时长榜</span>
                        </button>
                        <button
                            type="button"
                            role="tab"
                            class="tab-btn"
                            :class="{ active: activeTab === 'games' }"
                            :aria-selected="activeTab === 'games'"
                            @click="activeTab = 'games'">
                            <Flame :size="14" aria-hidden="true" />
                            <span>热门作品榜</span>
                        </button>
                    </div>

                    <div class="lb-sync-toggle" :title="uploadPlaytime ? '游玩时长已开启自动同步与排行' : '开启后游玩时长将自动同步并参与社区排行'">
                        <span class="sync-toggle-label">{{ uploadPlaytime ? '时长同步中' : '同步我的时长' }}</span>
                        <Switch
                            :model-value="uploadPlaytime"
                            size="sm"
                            aria-label="开启或关闭游玩时长同步"
                            @update:model-value="onTogglePlaytime" />
                    </div>
                </div>

                <!-- 列表容器 -->
                <div class="lb-body">
                    <!-- 未开启时长上报提示条 -->
                    <div v-if="!uploadPlaytime && !loading && !error" class="lb-optin-banner">
                        <div class="optin-left">
                            <Clock :size="14" class="optin-icon" aria-hidden="true" />
                            <span class="optin-text">游玩时长同步已关闭，开启后你的游玩数据将实时汇总并参与排行榜</span>
                        </div>
                        <button type="button" class="btn btn-primary btn-sm" @click="onTogglePlaytime(true)">
                            一键开启
                        </button>
                    </div>
                    <!-- 骨架屏 -->
                    <div v-if="loading" class="lb-skeleton" aria-label="正在加载排行榜">
                        <div v-for="i in 5" :key="i" class="skeleton-row">
                            <div class="sk-rank" />
                            <div class="sk-avatar" />
                            <div class="sk-info" />
                            <div class="sk-val" />
                        </div>
                    </div>

                    <!-- 错误状态 -->
                    <div v-else-if="error" class="lb-empty">
                        <p>{{ error }}</p>
                        <button type="button" class="btn btn-ghost btn-sm" @click="loadData">重试</button>
                    </div>

                    <!-- 玩家榜单 -->
                    <div v-else-if="activeTab === 'users'" class="lb-list-wrap">
                        <div v-if="userList.length === 0" class="lb-empty">
                            <p>暂无玩家时长记录</p>
                        </div>
                        <div v-else class="lb-table">
                            <div class="lb-thead" aria-hidden="true">
                                <span class="col-rank">排名</span>
                                <span class="col-main">玩家</span>
                                <span class="col-extra hide-mobile">主推作品</span>
                                <span class="col-val">累计时长</span>
                            </div>
                            <div
                                v-for="item in userList"
                                :key="item.rank + item.displayName"
                                class="lb-row"
                                :class="{ 'is-me': item.isMe }">
                                <div class="col-rank">
                                    <span class="rank-badge" :class="'rank-' + item.rank">
                                        {{ formatRank(item.rank) }}
                                    </span>
                                </div>

                                <div class="col-main">
                                    <div class="avatar-wrap">
                                        <img
                                            v-if="item.avatarUrl"
                                            class="avatar-img"
                                            :src="item.avatarUrl"
                                            :alt="item.displayName"
                                            loading="lazy">
                                        <div v-else class="avatar-fallback" aria-hidden="true">
                                            <EyeOff v-if="item.isAnonymous" :size="13" />
                                            <span v-else>{{ getInitial(item.displayName) }}</span>
                                        </div>
                                    </div>
                                    <div class="user-meta">
                                        <div class="user-name-line">
                                            <span class="user-name" :title="item.displayName">{{ item.displayName }}</span>
                                            <span v-if="item.isMe" class="badge-me">当前</span>
                                            <span v-else-if="item.isAnonymous" class="badge-anon">匿名</span>
                                        </div>
                                        <span class="user-sub">探索了 {{ item.gameCount }} 部作品</span>
                                    </div>
                                </div>

                                <div class="col-extra hide-mobile">
                                    <span v-if="item.topGame" class="top-game" :title="item.topGame">
                                        《{{ item.topGame }}》
                                    </span>
                                    <span v-else class="top-game-empty">-</span>
                                </div>

                                <div class="col-val">
                                    <span class="time-val">{{ fmtPlaytime(item.totalSeconds).val }}</span>
                                    <span class="time-unit">{{ fmtPlaytime(item.totalSeconds).unit }}</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- 热门作品榜单 -->
                    <div v-else class="lb-list-wrap">
                        <div v-if="gameList.length === 0" class="lb-empty">
                            <p>暂无作品游玩数据</p>
                        </div>
                        <div v-else class="lb-table">
                            <div class="lb-thead" aria-hidden="true">
                                <span class="col-rank">排名</span>
                                <span class="col-main">作品</span>
                                <span class="col-extra hide-mobile">参与玩家</span>
                                <span class="col-val">全服时长</span>
                            </div>
                            <a
                                v-for="item in gameList"
                                :key="item.gameId"
                                class="lb-row lb-row-link"
                                :href="`/game/${encodeURIComponent(item.gameId)}`">
                                <div class="col-rank">
                                    <span class="rank-badge" :class="'rank-' + item.rank">
                                        {{ formatRank(item.rank) }}
                                    </span>
                                </div>

                                <div class="col-main">
                                    <div class="game-cover-wrap">
                                        <img
                                            v-if="item.coverUrl"
                                            class="game-cover-img"
                                            :src="`/api/cover/${encodeURIComponent(item.gameId)}`"
                                            :alt="item.title"
                                            loading="lazy">
                                        <div v-else class="game-cover-fallback" aria-hidden="true">
                                            <Gamepad2 :size="14" />
                                        </div>
                                    </div>
                                    <div class="game-meta">
                                        <span class="game-title" :title="item.title">{{ item.title }}</span>
                                        <div v-if="item.tags?.length" class="game-tags">
                                            <span v-for="t in item.tags.slice(0, 2)" :key="t" class="tag-mini">{{ t }}</span>
                                        </div>
                                    </div>
                                </div>

                                <div class="col-extra hide-mobile">
                                    <span class="player-stat">
                                        <Users :size="12" aria-hidden="true" />
                                        <span>{{ item.playerCount }} 人</span>
                                    </span>
                                </div>

                                <div class="col-val">
                                    <span class="time-val">{{ fmtPlaytime(item.totalSeconds).val }}</span>
                                    <span class="time-unit">{{ fmtPlaytime(item.totalSeconds).unit }}</span>
                                </div>
                            </a>
                        </div>
                    </div>
                </div>
            </section>
        </div>
    </Teleport>
</template>

<style scoped>
.lb-backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--z-modal);
    display: grid;
    place-items: center;
    padding: 16px;
    background: rgba(0, 0, 0, 0.76);
    backdrop-filter: blur(8px);
}

.lb-panel {
    position: relative;
    width: min(760px, 100%);
    max-height: min(720px, 90vh);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    background: var(--bg-1);
    box-shadow: var(--shadow-lg);
}

.lb-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
    padding: 20px 24px 16px;
    border-bottom: 1px solid var(--line);
}

.lb-head-text {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.lb-title-wrap {
    display: flex;
    align-items: center;
    gap: var(--space-2);
}

.lb-title-wrap h2 {
    font-size: 17px;
    font-weight: 600;
    color: var(--fg-0);
    margin: 0;
}

.title-icon {
    color: var(--accent);
}

.lb-head-text p {
    margin: 0;
    font-size: 12px;
    color: var(--fg-2);
}

.btn-icon {
    width: 32px;
    height: 32px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
    color: var(--fg-2);
}

.btn-icon:hover {
    color: var(--fg-0);
    background: var(--bg-2);
}

.lb-tabs-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    padding: 10px 24px;
    background: var(--bg-2);
    border-bottom: 1px solid var(--line);
}

.lb-sync-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
}

.sync-toggle-label {
    font-size: 11px;
    color: var(--fg-2);
    white-space: nowrap;
    user-select: none;
}

.lb-tabs {
    display: inline-flex;
    background: var(--bg-1);
    padding: 3px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--line);
    gap: 2px;
}

.tab-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    font-size: 12px;
    font-weight: 500;
    color: var(--fg-2);
    background: transparent;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    transition: all var(--dur) var(--ease);
}

.tab-btn:hover {
    color: var(--fg-1);
}

.tab-btn.active {
    background: var(--bg-3);
    color: var(--fg-0);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
}

.lb-optin-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 14px;
    margin-bottom: 14px;
    border-radius: var(--radius-sm);
    background: var(--bg-2);
    border: 1px dashed var(--line-strong);
}

.optin-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
}

.optin-icon {
    color: var(--fg-2);
    flex-shrink: 0;
}

.optin-text {
    font-size: 12px;
    color: var(--fg-1);
    line-height: 1.5;
}

.lb-body {
    flex: 1;
    overflow-y: auto;
    padding: 12px 24px 24px;
}

.lb-skeleton {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-4) 0;
}

.skeleton-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) 0;
}

.sk-rank { width: 28px; height: 18px; background: var(--bg-2); border-radius: var(--radius-sm); }
.sk-avatar { width: 32px; height: 32px; background: var(--bg-2); border-radius: var(--radius-sm); }
.sk-info { flex: 1; height: 18px; background: var(--bg-2); border-radius: var(--radius-sm); }
.sk-val { width: 56px; height: 18px; background: var(--bg-2); border-radius: var(--radius-sm); }

.lb-empty {
    padding: var(--space-7) 0;
    text-align: center;
    color: var(--fg-2);
    font-size: 13px;
}

.lb-table {
    display: flex;
    flex-direction: column;
}

.lb-thead {
    display: flex;
    align-items: center;
    font-size: 11px;
    color: var(--fg-2);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 6px var(--space-2) 10px;
    border-bottom: 1px solid var(--line);
}

.col-rank { width: 42px; flex-shrink: 0; }
.col-main { flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--space-3); }
.col-extra { width: 200px; flex-shrink: 0; color: var(--fg-2); font-size: 12px; }
.col-val { width: 90px; flex-shrink: 0; text-align: right; font-variant-numeric: tabular-nums; }

.lb-row {
    display: flex;
    align-items: center;
    padding: 10px var(--space-2);
    border-radius: var(--radius-sm);
    border-bottom: 1px solid var(--line);
    transition: background-color var(--dur) var(--ease);
}

.lb-row:hover {
    background: var(--bg-2);
}

.lb-row.is-me {
    background: var(--accent-dim);
}

.lb-row-link {
    text-decoration: none;
    color: inherit;
}

.rank-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 24px;
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    border-radius: var(--radius-sm);
    color: var(--fg-2);
}

.rank-1 { color: var(--fg-0); background: rgba(255, 255, 255, 0.12); border: 1px solid var(--line-strong); }
.rank-2 { color: var(--fg-1); background: rgba(255, 255, 255, 0.06); }
.rank-3 { color: var(--fg-2); background: rgba(255, 255, 255, 0.03); }

.avatar-wrap {
    width: 32px;
    height: 32px;
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: var(--bg-2);
    border: 1px solid var(--line);
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
}

.avatar-img { width: 100%; height: 100%; object-fit: cover; }
.avatar-fallback { font-size: 12px; font-weight: 600; color: var(--fg-1); }

.user-meta, .game-meta {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.user-name-line {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
}

.user-name {
    font-size: 13px;
    font-weight: 500;
    color: var(--fg-0);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.user-sub {
    font-size: 11px;
    color: var(--fg-2);
}

.badge-me {
    font-size: 10px;
    padding: 1px 5px;
    background: var(--accent);
    color: var(--bg-0);
    font-weight: 600;
    border-radius: 4px;
    flex-shrink: 0;
}

.badge-anon {
    font-size: 10px;
    padding: 1px 5px;
    background: var(--bg-3);
    color: var(--fg-2);
    border-radius: 4px;
    flex-shrink: 0;
}

.top-game {
    font-size: 12px;
    color: var(--fg-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: block;
}

.top-game-empty {
    color: var(--fg-2);
}

.game-cover-wrap {
    width: 44px;
    height: 32px;
    border-radius: 4px;
    overflow: hidden;
    background: var(--bg-2);
    border: 1px solid var(--line);
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
}

.game-cover-img { width: 100%; height: 100%; object-fit: cover; }
.game-cover-fallback { color: var(--fg-2); }

.game-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--fg-0);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.game-tags {
    display: flex;
    gap: 4px;
}

.tag-mini {
    font-size: 10px;
    padding: 0 4px;
    background: var(--bg-3);
    color: var(--fg-2);
    border-radius: 3px;
}

.player-stat {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: var(--fg-1);
}

.time-val {
    font-size: 14px;
    font-weight: 600;
    color: var(--fg-0);
}

.time-unit {
    font-size: 11px;
    color: var(--fg-2);
    margin-left: 2px;
}

@media (max-width: 680px) {
    .lb-backdrop { padding: 0; align-items: end; }
    .lb-panel { width: 100%; max-height: 90dvh; border-radius: var(--radius) var(--radius) 0 0; }
    .lb-head, .lb-tabs-bar, .lb-body { padding-left: 16px; padding-right: 16px; }
    .hide-mobile { display: none !important; }
}
</style>
