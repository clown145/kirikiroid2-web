<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { Trophy, Clock, Users, EyeOff, User } from '@lucide/vue';
import { api } from '../shared/api.js';
import { getSetting, setSetting } from '../shared/settings.js';
import { toast } from '../shared/toast.js';
import Switch from '../shared/Switch.vue';

const props = defineProps({
    gameId: { type: String, required: true },
    account: { type: Object, default: null }
});

const loading = ref(true);
const error = ref('');
const stats = ref({ playerCount: 0, totalSeconds: 0 });
const leaderboard = ref([]);
const myRank = ref(null);
const uploadPlaytime = ref(getSetting('uploadPlaytime', false));

function onTogglePlaytime(checked) {
    uploadPlaytime.value = checked;
    setSetting('uploadPlaytime', checked);
    if (checked) {
        toast.success('已开启游玩时长记录与排行同步');
    } else {
        toast.info('已关闭游玩时长同步');
    }
}

function fmtPlaytime(seconds) {
    if (!seconds || seconds <= 0) return { val: '0', unit: 'm' };
    const mins = Math.floor(seconds / 60);
    if (mins < 60) {
        return { val: String(Math.max(1, mins)), unit: 'm' };
    }
    const hours = (seconds / 3600).toFixed(1);
    return { val: hours, unit: 'h' };
}

function fmtTotalHours(seconds) {
    if (!seconds || seconds <= 0) return '0 小时';
    const hours = (seconds / 3600).toFixed(1);
    return `${hours} 小时`;
}

function formatRank(rank) {
    return rank < 10 ? `0${rank}` : String(rank);
}

function getInitial(name) {
    return (name || '?').trim().charAt(0).toUpperCase();
}

async function fetchLeaderboard() {
    if (!props.gameId) return;
    loading.value = true;
    error.value = '';
    try {
        const res = await api.getGameLeaderboard(props.gameId);
        stats.value = res.stats || { playerCount: 0, totalSeconds: 0 };
        leaderboard.value = res.leaderboard || [];
        myRank.value = res.myRank || null;
    } catch (err) {
        error.value = err.message || '加载排行榜失败';
    } finally {
        loading.value = false;
    }
}

onMounted(() => {
    fetchLeaderboard();
});

watch(() => props.gameId, () => {
    fetchLeaderboard();
});
</script>

<template>
    <section class="game-leaderboard">
        <div class="board-header">
            <div class="board-title">
                <Trophy class="title-icon" :size="17" aria-hidden="true" />
                <h2>游玩排行榜</h2>
            </div>
            <div v-if="!loading && stats.playerCount > 0" class="board-stats">
                <span class="stat-item" :title="`参与玩家: ${stats.playerCount} 人`">
                    <Users :size="13" aria-hidden="true" />
                    <span>{{ stats.playerCount }} 位玩家</span>
                </span>
                <span class="stat-sep" aria-hidden="true">·</span>
                <span class="stat-item" :title="`全服累计: ${fmtTotalHours(stats.totalSeconds)}`">
                    <Clock :size="13" aria-hidden="true" />
                    <span>累计 {{ fmtTotalHours(stats.totalSeconds) }}</span>
                </span>
            </div>
        </div>

        <!-- 未开启上报时的轻量快捷提示 -->
        <div v-if="!uploadPlaytime && !loading && !error" class="board-optin-bar">
            <span class="optin-bar-text">未开启时长记录，开启后你的游玩数据将实时参与本作品排行</span>
            <div class="optin-bar-action">
                <Switch
                    :model-value="uploadPlaytime"
                    size="sm"
                    aria-label="开启或关闭游玩时长同步"
                    @update:model-value="onTogglePlaytime" />
            </div>
        </div>

        <!-- 骨架屏 -->
        <div v-if="loading" class="board-skeleton" aria-label="正在加载排行榜">
            <div v-for="i in 3" :key="i" class="skeleton-row">
                <div class="sk-rank" />
                <div class="sk-avatar" />
                <div class="sk-name" />
                <div class="sk-time" />
            </div>
        </div>

        <!-- 错误提示 -->
        <div v-else-if="error" class="board-empty">
            <p class="empty-text">{{ error }}</p>
            <button type="button" class="btn btn-ghost btn-sm" @click="fetchLeaderboard">重试</button>
        </div>

        <!-- 空状态 -->
        <div v-else-if="leaderboard.length === 0" class="board-empty">
            <p class="empty-text">暂无游玩记录，成为第一位通关者吧</p>
        </div>

        <!-- 榜单主体 -->
        <div v-else class="board-list">
            <div class="board-table-head" aria-hidden="true">
                <span class="col-rank">排名</span>
                <span class="col-user">玩家</span>
                <span class="col-time">游玩时长</span>
            </div>

            <div
                v-for="item in leaderboard"
                :key="item.rank + (item.userId || item.displayName)"
                class="board-row"
                :class="{ 'is-me': item.isMe, 'top-1': item.rank === 1, 'top-2': item.rank === 2, 'top-3': item.rank === 3 }">
                <div class="col-rank">
                    <span class="rank-badge" :class="'rank-' + item.rank">
                        {{ formatRank(item.rank) }}
                    </span>
                </div>

                <div class="col-user">
                    <div class="avatar-wrap">
                        <img
                            v-if="item.avatarUrl"
                            class="avatar-img"
                            :src="item.avatarUrl"
                            :alt="item.displayName"
                            loading="lazy"
                            decoding="async">
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
                    </div>
                </div>

                <div class="col-time">
                    <span class="time-val">{{ fmtPlaytime(item.totalSeconds).val }}</span>
                    <span class="time-unit">{{ fmtPlaytime(item.totalSeconds).unit }}</span>
                </div>
            </div>

            <!-- 当前玩家贴底行（如果未进入前排榜单） -->
            <div
                v-if="myRank && !myRank.inTopList"
                class="board-row my-rank-sticky">
                <div class="col-rank">
                    <span class="rank-badge rank-sub">
                        {{ myRank.rank > 99 ? '99+' : formatRank(myRank.rank) }}
                    </span>
                </div>

                <div class="col-user">
                    <div class="avatar-wrap">
                        <img
                            v-if="account?.avatarUrl"
                            class="avatar-img"
                            :src="account.avatarUrl"
                            :alt="account.displayName"
                            loading="lazy">
                        <div v-else class="avatar-fallback" aria-hidden="true">
                            <span>{{ getInitial(account?.displayName || '我') }}</span>
                        </div>
                    </div>

                    <div class="user-meta">
                        <div class="user-name-line">
                            <span class="user-name">{{ account?.displayName || '我' }}</span>
                            <span class="badge-me">当前</span>
                        </div>
                    </div>
                </div>

                <div class="col-time">
                    <span class="time-val">{{ fmtPlaytime(myRank.totalSeconds).val }}</span>
                    <span class="time-unit">{{ fmtPlaytime(myRank.totalSeconds).unit }}</span>
                </div>
            </div>
        </div>
    </section>
</template>

<style scoped>
.game-leaderboard {
    margin-top: var(--space-6);
    background: var(--bg-1);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: var(--space-4) var(--space-5);
}

.board-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
    padding-bottom: var(--space-3);
    border-bottom: 1px solid var(--line);
    flex-wrap: wrap;
}

.board-title {
    display: flex;
    align-items: center;
    gap: var(--space-2);
}

.board-title h2 {
    font-size: 15px;
    font-weight: 600;
    color: var(--fg-0);
    margin: 0;
    letter-spacing: -0.01em;
}

.title-icon {
    color: var(--accent);
}

.board-stats {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: 12px;
    color: var(--fg-2);
    font-variant-numeric: tabular-nums;
}

.stat-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
}

.stat-sep {
    opacity: 0.5;
}

.board-optin-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 12px;
    margin-bottom: var(--space-3);
    border-radius: var(--radius-sm);
    background: var(--bg-2);
    border: 1px dashed var(--line-strong);
}

.optin-bar-text {
    font-size: 11px;
    color: var(--fg-2);
    line-height: 1.4;
}

.optin-bar-action {
    flex-shrink: 0;
}

.board-skeleton {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
}

.skeleton-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) 0;
}

.sk-rank { width: 24px; height: 16px; background: var(--bg-2); border-radius: var(--radius-sm); }
.sk-avatar { width: 28px; height: 28px; background: var(--bg-2); border-radius: var(--radius-sm); }
.sk-name { flex: 1; height: 16px; background: var(--bg-2); border-radius: var(--radius-sm); }
.sk-time { width: 48px; height: 16px; background: var(--bg-2); border-radius: var(--radius-sm); }

.board-empty {
    padding: var(--space-6) 0;
    text-align: center;
    color: var(--fg-2);
    font-size: 13px;
}

.empty-text {
    margin-bottom: var(--space-2);
}

.board-list {
    display: flex;
    flex-direction: column;
}

.board-table-head {
    display: flex;
    align-items: center;
    font-size: 11px;
    color: var(--fg-2);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0 var(--space-2) var(--space-2);
    border-bottom: 1px solid var(--line);
}

.col-rank {
    width: 36px;
    flex-shrink: 0;
}

.col-user {
    flex: 1;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
}

.col-time {
    width: 80px;
    flex-shrink: 0;
    text-align: right;
    font-variant-numeric: tabular-nums;
}

.board-row {
    display: flex;
    align-items: center;
    padding: var(--space-2) var(--space-2);
    border-radius: var(--radius-sm);
    transition: background-color var(--dur) var(--ease);
}

.board-row:hover {
    background: var(--bg-2);
}

.board-row.is-me {
    background: var(--accent-dim);
    border-left: 2px solid var(--accent);
}

.board-row.my-rank-sticky {
    margin-top: var(--space-3);
    border-top: 1px dashed var(--line-strong);
    padding-top: var(--space-3);
    background: var(--bg-2);
}

.rank-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 22px;
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    border-radius: var(--radius-sm);
    color: var(--fg-2);
}

.rank-1 {
    color: var(--fg-0);
    background: rgba(255, 255, 255, 0.12);
    border: 1px solid var(--line-strong);
}

.rank-2 {
    color: var(--fg-1);
    background: rgba(255, 255, 255, 0.06);
}

.rank-3 {
    color: var(--fg-2);
    background: rgba(255, 255, 255, 0.03);
}

.avatar-wrap {
    width: 28px;
    height: 28px;
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: var(--bg-2);
    border: 1px solid var(--line);
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
}

.avatar-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.avatar-fallback {
    font-size: 11px;
    font-weight: 600;
    color: var(--fg-1);
}

.user-meta {
    min-width: 0;
    flex: 1;
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
</style>
