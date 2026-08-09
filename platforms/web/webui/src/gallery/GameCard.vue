<script setup>
import { ref, computed, onMounted } from 'vue';
import { coverSrc } from '../shared/api.js';

const props = defineProps({
    game: { type: Object, required: true }
});

const failed = ref(false);
const src = computed(() => (failed.value ? null : coverSrc(props.game)));
const cacheInfo = ref(null);
const cacheError = ref(false);
const clearing = ref(false);

// 无封面时用标题首字符占位，比一张通用 icon 更容易区分条目
const initial = computed(() => (props.game.title || '?').trim().charAt(0).toUpperCase());

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024)
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const cacheLabel = computed(() => {
    if (cacheError.value) return '缓存状态不可用';
    if (!cacheInfo.value) return '正在读取缓存';
    if (!cacheInfo.value.available) return '浏览器不支持持久缓存';
    if (!cacheInfo.value.bytes) return '未缓存资源';
    return `已缓存 ${formatBytes(cacheInfo.value.bytes)}`;
});

async function refreshCacheInfo() {
    if (!window.KrKr2GameCache) {
        cacheError.value = true;
        return;
    }
    try {
        cacheInfo.value = await window.KrKr2GameCache.getGameInfo(props.game.id);
        cacheError.value = false;
    } catch (err) {
        console.warn('[gallery] 读取游戏缓存失败:', err);
        cacheError.value = true;
    }
}

async function clearCache() {
    if (!cacheInfo.value?.bytes || clearing.value) return;
    if (!window.confirm(`清理《${props.game.title}》的资源缓存？\n\n游戏存档不会被删除。`))
        return;
    clearing.value = true;
    try {
        await window.KrKr2GameCache.deleteGame(props.game.id);
        await refreshCacheInfo();
    } catch (err) {
        console.error('[gallery] 清理游戏缓存失败:', err);
        window.alert(`清理缓存失败：${err.message || err}`);
    } finally {
        clearing.value = false;
    }
}

onMounted(refreshCacheInfo);
</script>

<template>
    <article class="card">
        <a class="card-link" :href="`/play/${encodeURIComponent(game.id)}`">
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
                        <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20" aria-hidden="true">
                            <path d="M8 5v14l11-7z" />
                        </svg>
                    </span>
                </div>

                <span v-if="game.pinned" class="pin" title="置顶">置顶</span>
            </div>

            <div class="meta">
                <h3 class="title">{{ game.title }}</h3>
                <p v-if="game.description" class="desc">{{ game.description }}</p>
                <div v-if="game.tags.length" class="tags">
                    <span v-for="tag in game.tags.slice(0, 3)" :key="tag" class="tag">{{ tag }}</span>
                </div>
            </div>
        </a>

        <div class="cache-row">
            <span class="cache-size" :title="cacheLabel">{{ cacheLabel }}</span>
            <button
                class="cache-clear"
                type="button"
                :disabled="!cacheInfo?.bytes || clearing"
                :aria-label="`清理《${game.title}》的资源缓存`"
                :title="cacheInfo?.bytes ? '清理资源缓存（保留存档）' : '没有可清理的资源缓存'"
                @click="clearCache">
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true">
                    <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zm3.46-7.12 1.41-1.41L12 11.59l1.12-1.12 1.41 1.41L13.41 13l1.12 1.12-1.41 1.41L12 14.41l-1.12 1.12-1.41-1.41L10.59 13l-1.13-1.12zM15.5 4l-1-1h-5l-1 1H5v2h14V4z" />
                </svg>
            </button>
        </div>
    </article>
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

.card-link {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
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

.card-link:hover .overlay { opacity: 1; }

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

.cache-row {
    min-height: 42px;
    padding: 5px var(--space-2) 5px var(--space-3);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    border-top: 1px solid var(--line);
    background: var(--bg-0);
}

.cache-size {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg-2);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
}

.cache-clear {
    width: 32px;
    height: 32px;
    flex: 0 0 32px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--fg-1);
    transition: background var(--dur) var(--ease),
                color var(--dur) var(--ease);
}

.cache-clear:hover:not(:disabled) {
    background: var(--bg-2);
    color: var(--fg-0);
}

.cache-clear:disabled {
    opacity: 0.35;
    cursor: default;
}
</style>
