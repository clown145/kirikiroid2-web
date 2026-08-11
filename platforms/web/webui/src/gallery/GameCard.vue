<script setup>
import { ref, computed } from 'vue';
import { coverSrc } from '../shared/api.js';

const props = defineProps({
    game: { type: Object, required: true },
    // 该游戏的持久缓存 {bytes, size, complete}；未缓存过为 null
    cacheInfo: { type: Object, default: null },
    // 当前正在下载的就是它时的状态 {pct, running, paused}
    downloading: { type: Object, default: null }
});

const emit = defineEmits(['download', 'navigate']);

const failed = ref(false);
const src = computed(() => (failed.value ? null : coverSrc(props.game)));

// 无封面时用标题首字符占位，比一张通用 icon 更容易区分条目
const initial = computed(() => (props.game.title || '?').trim().charAt(0).toUpperCase());

const cached = computed(() => !!props.cacheInfo?.complete);
const partialPct = computed(() => {
    const c = props.cacheInfo;
    if (!c || !c.size || c.complete) return 0;
    return Math.min(99, Math.round((c.bytes / c.size) * 100));
});

const downloadTitle = computed(() => {
    if (cached.value) return '已完整下载到本地，游玩时不再消耗流量';
    if (props.downloading?.retrying) return '网络暂时中断，正在自动续传；点击停止';
    if (props.downloading) return '正在下载，点击暂停';
    if (partialPct.value > 0) return `继续下载（已有 ${partialPct.value}%）`;
    return '完整下载：先下完再玩，全程无加载等待';
});

function fmt(bytes) {
    if (!bytes) return '0 MB';
    const mb = bytes / 1048576;
    return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB';
}
</script>

<template>
    <a
        class="card"
        :href="`/play/${encodeURIComponent(game.id)}`"
        @click="emit('navigate', $event)">
        <div class="cover">
            <img
                v-if="src"
                :src="src"
                :alt="game.title"
                loading="lazy"
                decoding="async"
                @error="failed = true">
            <div v-else class="cover-fallback" aria-hidden="true">{{ initial }}</div>

            <div class="overlay">
                <span class="play">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                        <path d="M8 5v14l11-7z" />
                    </svg>
                </span>
            </div>

            <span v-if="game.pinned" class="pin" title="置顶">置顶</span>

            <!-- 下载按钮嵌在 <a> 里，必须 stop + prevent，否则点它会跳去玩 -->
            <button
                v-if="game.downloadUrl"
                class="dl-btn"
                :class="{ cached, active: !!downloading }"
                type="button"
                :title="downloadTitle"
                :aria-label="downloadTitle"
                @click.prevent.stop="emit('download')">
                <svg v-if="cached" viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true">
                    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                </svg>
                <svg v-else-if="downloading" viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true">
                    <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
                </svg>
                <svg v-else viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true">
                    <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" />
                </svg>
            </button>

            <!-- 下载中/已部分下载的进度条压在封面底边 -->
            <div v-if="downloading || partialPct" class="progress">
                <span :style="{ width: (downloading?.pct ?? partialPct) + '%' }" />
            </div>
        </div>

        <div class="meta">
            <h3 class="title">{{ game.title }}</h3>
            <p v-if="game.description" class="desc">{{ game.description }}</p>
            <div class="foot">
                <div v-if="game.tags.length" class="tags">
                    <span v-for="tag in game.tags.slice(0, 3)" :key="tag" class="tag">{{ tag }}</span>
                </div>
                <span v-if="cached" class="cache-note" :title="`已缓存 ${fmt(cacheInfo.bytes)}`">已下载</span>
                <span v-else-if="downloading" class="cache-note on">
                    {{ downloading.retrying ? '续传中' : downloading.pct + '%' }}
                </span>
                <span v-else-if="partialPct" class="cache-note">{{ partialPct }}%</span>
            </div>
        </div>
    </a>
</template>

<style scoped>
.card {
    display: flex;
    flex-direction: column;
    background: var(--bg-1);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    overflow: hidden;
    transition: transform var(--dur) var(--ease),
                border-color var(--dur) var(--ease),
                background var(--dur) var(--ease);
}

/* 克制的 hover：位移 2px + 边框提亮。不用放大和彩色阴影。 */
.card:hover {
    transform: translateY(-2px);
    border-color: var(--line-strong);
    background: var(--bg-2);
}

.cover {
    position: relative;
    aspect-ratio: 3 / 4;   /* galgame 封面惯例竖版 */
    background: var(--bg-2);
    overflow: hidden;
}

.cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
}

.cover-fallback {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    font-size: 48px;
    font-weight: 300;
    color: var(--fg-2);
    background: linear-gradient(160deg, var(--bg-2), var(--bg-1));
}

.overlay {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, 0.5);
    opacity: 0;
    transition: opacity var(--dur) var(--ease);
}

.card:hover .overlay { opacity: 1; }

.play {
    width: 46px;
    height: 46px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.95);
    color: #000;
    padding-left: 3px;   /* 三角形视觉居中 */
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

.meta {
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1;
}

.title {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    line-height: 1.35;
    /* 标题最多两行，超出省略 */
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
}

.desc {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--fg-1);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
}

.tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    margin-top: auto;
    padding-top: 2px;
}

/* 下载入口。常驻而非 hover 才出现 —— 触屏没有 hover，藏起来就点不到。 */
.dl-btn {
    position: absolute;
    top: var(--space-2);
    right: var(--space-2);
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.65);
    backdrop-filter: blur(8px);
    color: var(--fg-0);
    cursor: pointer;
    opacity: 0.85;
    transition: opacity var(--dur) var(--ease), background var(--dur) var(--ease);
}

.dl-btn:hover { opacity: 1; background: rgba(0, 0, 0, 0.85); }
.dl-btn.cached { color: #6ee7a8; }
.dl-btn.active { background: rgba(37, 99, 235, 0.9); opacity: 1; }

.progress {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 3px;
    background: rgba(0, 0, 0, 0.5);
}

.progress span {
    display: block;
    height: 100%;
    background: var(--fg-0);
    transition: width 240ms var(--ease);
}

.foot {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-1);
    margin-top: auto;
    padding-top: 2px;
}

.foot .tags { margin-top: 0; padding-top: 0; }

.cache-note {
    flex: none;
    font-size: 10px;
    color: var(--fg-2);
    white-space: nowrap;
}

.cache-note.on { color: var(--fg-1); }
</style>
