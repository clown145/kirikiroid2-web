<script setup>
// 顶部边缘唤出工具条。
//
// 取代旧的 #game-controls-bar —— 那个常驻在右上角，永远挡着画面。
// 鼠标：指针移到屏幕最顶端 6px 即滑出。
// 桌面端保留一个紧凑的顶部把手，触屏端则扩大命中区并支持顶边下滑 ——
// 只靠下滑在手机上不可靠（引擎会吃掉 canvas 上的 touch，系统/浏览器又会
// 抢顶边手势）。
// 露出后 3 秒无交互自动收起；指针停在条上时不收。

import { ref, computed, watch, onMounted, onUnmounted } from 'vue';

const props = defineProps({
    title: { type: String, default: '' },
    isFullscreen: { type: Boolean, default: false },
    fullscreenAvailable: { type: Boolean, default: true },
    // 边玩边下开关与当前缓存进度。cacheState 为 null 表示该来源不支持
    // 缓存（本地文件、?xp3= 调试入口），此时整个按钮不出现。
    downloadEnabled: { type: Boolean, default: false },
    cacheState: { type: Object, default: null }
});

const emit = defineEmits(['exit', 'toggle-fullscreen', 'open-saves', 'toggle-download']);

const downloadLabel = computed(() => {
    const s = props.cacheState;
    if (!s) return '边玩边下';
    if (s.done) return '已缓存';
    if (props.downloadEnabled) return `下载中 ${s.pct}%`;
    return s.pct > 0 ? `已缓存 ${s.pct}%` : '边玩边下';
});

// 利弊都写出来：不写清代价（流量、抢带宽），玩家没法判断该不该开
const downloadTitle = computed(() => {
    if (props.cacheState?.done) return '本作资源已全部缓存到本地，不会再产生下载流量。';
    return props.downloadEnabled
        ? '边玩边下：开启中。\n后台补齐剩余资源，玩到哪都不用等，最终整包留在本地。\n代价：会下载你可能永远看不到的分支与结局资源；弱网下可能与当前读取抢带宽。'
        : '边玩边下：已关闭。\n只下载当前真正需要的字节，最省流量。\n首次经过的场景会有加载等待。';
});

const visible = ref(false);
const hovering = ref(false);
// 首次进入给一次性提示，让用户知道 UI 藏在哪儿
const showHint = ref(true);
// 无悬停能力的设备（手机/平板）：热区靠不住，得给一个能点的把手
const isTouch = ref(false);
// 把手已淡出：视觉上彻底消失，命中区收窄但仍在
const handleDimmed = ref(false);

const HOT_ZONE_PX = 6;
const AUTO_HIDE_MS = 3000;

// 把手只在最初几秒亮着，之后淡到全透明 —— 它是画面上唯一常驻的遮挡物。
// 淡掉后**不撤命中区**，只把它收成贴顶的一条窄带：顶边下滑偶尔还是会被
// 系统手势（下拉通知栏）截走，全屏里又没有 hover 和 F 键，
// 必须留一个看不见但点得到的逃生口，否则只能杀标签页。
const HANDLE_FADE_MS = 6000;

let hideTimer = null;
let fadeTimer = null;
let hintTimer = null;

function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
        if (!hovering.value) visible.value = false;
    }, AUTO_HIDE_MS);
}

function reveal() {
    visible.value = true;
    showHint.value = false;
    scheduleHide();
}

// 缓存要等游戏源挂载后才出现。此刻主动展开一次，让边玩边下开关不会
// 因工具栏早已收起而完全不可发现。
watch(() => props.cacheState, (value, previous) => {
    if (value && !previous) reveal();
});

function onPointerMove(e) {
    if (e.clientY <= HOT_ZONE_PX) reveal();
}

// 触屏：从顶部边缘起手下滑。
// 起手区放宽到 48px、位移阈值降到 16px —— 手机上顶边最外侧那几像素常被
// 系统手势（下拉通知栏 / 浏览器 UI）先截走，卡在 24px 基本划不出来。
const TOUCH_START_ZONE_PX = 48;
const TOUCH_DRAG_PX = 16;

let touchStartY = null;
let lastTopTap = 0;

function onTouchStart(e) {
    touchStartY = e.touches[0]?.clientY ?? null;
}

function onTouchMove(e) {
    if (touchStartY === null) return;
    const y = e.touches[0]?.clientY ?? 0;
    if (touchStartY <= TOUCH_START_ZONE_PX && y - touchStartY > TOUCH_DRAG_PX) {
        reveal();
        touchStartY = null;
    }
}

function onTouchEnd(e) {
    const touch = e.changedTouches[0];
    if (touch && touch.clientY <= 64) {
        const now = Date.now();
        if (now - lastTopTap < 380) {
            reveal();
            lastTopTap = 0;
        } else {
            lastTopTap = now;
        }
    }
}

function onKeydown(e) {
    // 输入框里不抢键
    if (e.target instanceof HTMLElement &&
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

    if (e.key === 'Escape') { reveal(); return; }
    if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        emit('toggle-fullscreen');
    }
}

function onBarEnter() {
    hovering.value = true;
    clearTimeout(hideTimer);
}

function onBarLeave() {
    hovering.value = false;
    scheduleHide();
}

// capture 阶段监听：引擎在 canvas 上注册的 touch 处理器会 stopPropagation，
// 冒泡阶段的 window 监听收不到事件，手机上就完全唤不出工具条。
// capture 让我们先于 canvas 拿到事件；passive 保证不影响引擎自己的手势。
const TOUCH_OPTS = { passive: true, capture: true };

onMounted(() => {
    isTouch.value = window.matchMedia('(hover: none)').matches;

    // 一旦淡出就不再自己亮回来：用户已经知道入口在哪，
    // 再周期性闪出来又变成新的干扰。
    fadeTimer = setTimeout(() => { handleDimmed.value = true; }, HANDLE_FADE_MS);

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('touchstart', onTouchStart, TOUCH_OPTS);
    window.addEventListener('touchmove', onTouchMove, TOUCH_OPTS);
    window.addEventListener('touchend', onTouchEnd, TOUCH_OPTS);
    window.addEventListener('keydown', onKeydown);
    // 提示和把手一起退场：提示先走的话，会出现"箭头还亮着但没人解释它"的空档
    hintTimer = setTimeout(() => { showHint.value = false; }, HANDLE_FADE_MS);
});

onUnmounted(() => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('touchstart', onTouchStart, TOUCH_OPTS);
    window.removeEventListener('touchmove', onTouchMove, TOUCH_OPTS);
    window.removeEventListener('touchend', onTouchEnd, TOUCH_OPTS);
    window.removeEventListener('keydown', onKeydown);
    clearTimeout(hideTimer);
    clearTimeout(fadeTimer);
    clearTimeout(hintTimer);
});
</script>

<template>
    <!-- 热区本身不可见、不吃事件，只用来兜住指针位置判断 -->
    <div class="hotzone" aria-hidden="true" />

    <!-- 顶部兜底入口：桌面端紧凑显示；手机没有 hover，命中区扩大到 44px。 -->
    <button
        v-if="!visible"
        class="handle"
        :class="{ dimmed: handleDimmed && isTouch, touch: isTouch }"
        type="button"
        aria-label="显示控制栏"
        @click="reveal">
        <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="12" aria-hidden="true">
            <path d="M7 10l5 5 5-5z" />
        </svg>
    </button>

    <Transition name="slide">
        <div
            v-show="visible"
            class="bar"
            @pointerenter="onBarEnter"
            @pointerleave="onBarLeave">
            <button class="btn btn-ghost btn-sm" @click="emit('exit')" title="退出游戏（回到游戏库）">
                <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true">
                    <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
                </svg>
                退出
            </button>

            <span class="title" :title="title">{{ title }}</span>

            <div class="right">
                <button
                    v-if="cacheState"
                    class="btn btn-ghost btn-sm dl"
                    :class="{ on: downloadEnabled, done: cacheState.done }"
                    @click="emit('toggle-download')"
                    :title="downloadTitle">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true">
                        <path v-if="cacheState.done" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                        <path v-else d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" />
                    </svg>
                    {{ downloadLabel }}
                </button>

                <button class="btn btn-ghost btn-sm" @click="emit('open-saves')" title="存档空间">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true">
                        <path d="M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-4-4zm-5 16a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm3-10H5V5h10v4z" />
                    </svg>
                    存档
                </button>

                <button
                    v-if="fullscreenAvailable"
                    class="btn btn-ghost btn-sm"
                    @click="emit('toggle-fullscreen')"
                    :title="isFullscreen ? '退出全屏 (F)' : '全屏 (F)'">
                    <svg v-if="!isFullscreen" viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true">
                        <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
                    </svg>
                    <svg v-else viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true">
                        <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
                    </svg>
                    {{ isFullscreen ? '退出全屏' : '全屏' }}
                </button>
            </div>
        </div>
    </Transition>

    <!-- 一次性提示：告诉用户控制条在哪，随后自行消失 -->
    <Transition name="fade">
        <div v-if="showHint && !visible" class="hint-toast" :class="{ 'below-handle': isTouch }">
            <template v-if="isTouch">点顶部箭头，或从顶边下滑</template>
            <template v-else>移动到顶部显示控制栏 · <kbd>F</kbd> 全屏</template>
        </div>
    </Transition>
</template>

<style scoped>
.hotzone {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 6px;
    z-index: calc(var(--z-toolbar) - 1);
    pointer-events: none;
}

/* 顶部把手：贴顶居中，默认很淡，不抢画面。
   z-index 要压过 LocalPicker 的 .backdrop，否则选文件界面上把手点不动。 */
.handle {
    position: fixed;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    z-index: calc(var(--z-toolbar) + 1);
    display: grid;
    place-items: center;
    width: 56px;
    /* 命中区撑到 44px 以上（最小可点尺寸），视觉上仍是个小箭头 */
    min-height: 44px;
    padding: 8px 0 12px;
    padding-top: max(8px, env(safe-area-inset-top));
    border: 0;
    border-radius: 0 0 12px 12px;
    background: rgba(10, 10, 11, 0.45);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    color: var(--fg-2);
    opacity: 0.55;
    transition: opacity var(--dur) var(--ease);
}

.handle:active { opacity: 1; }
.handle:not(.touch) {
    width: 40px;
    min-height: 24px;
    padding: 3px 0 5px;
    border-radius: 0 0 6px 6px;
    opacity: 0.35;
}
.handle:not(.touch):hover { opacity: 1; }

/* 淡出后：视觉上完全透明，命中区收成贴顶窄带，点它依然可触发 */
.handle.dimmed {
    opacity: 0;
    min-height: 24px;
    height: 24px;
    width: 64px;
    padding: 0;
    background: transparent;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    transition: opacity 1.2s var(--ease);
}

/* 淡出后再按下或悬停时给明确反馈 */
.handle.dimmed:hover,
.handle.dimmed:active {
    opacity: 0.85;
    background: rgba(10, 10, 11, 0.6);
    transition: opacity 80ms var(--ease);
}

/* 明确表达意图：淡出是纯装饰性的渐变，
   开了减弱动效就直接切换，不做长过渡 */
@media (prefers-reduced-motion: reduce) {
    .handle, .handle.dimmed { transition: none; }
}

.bar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: var(--z-toolbar);
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    /* 顶部有刘海/状态栏时（全屏 + viewport-fit=cover）不被遮住 */
    padding-top: max(var(--space-2), env(safe-area-inset-top));
    background: rgba(10, 10, 11, 0.72);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    border-bottom: 1px solid var(--line);
}

.title {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    font-weight: 500;
    color: var(--fg-1);
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.right { display: flex; gap: var(--space-1); }

/* 边玩边下按钮：开启时才着色，关闭态与其余按钮一致，不喧宾夺主 */
.dl.on { color: var(--fg-0); background: rgba(255, 255, 255, 0.14); }
.dl.done { color: var(--fg-2); }

.slide-enter-active, .slide-leave-active {
    transition: transform var(--dur) var(--ease), opacity var(--dur) var(--ease);
}
.slide-enter-from, .slide-leave-to {
    transform: translateY(-100%);
    opacity: 0;
}

.hint-toast {
    position: fixed;
    top: var(--space-4);
    left: 50%;
    transform: translateX(-50%);
    z-index: var(--z-toolbar);
    padding: 7px 14px;
    border-radius: 999px;
    background: rgba(10, 10, 11, 0.8);
    backdrop-filter: blur(12px);
    border: 1px solid var(--line);
    font-size: 12px;
    color: var(--fg-1);
    pointer-events: none;
    white-space: nowrap;
}

/* 触屏时把手占着顶部居中，提示往下让一段，避免叠在一起 */
.hint-toast.below-handle {
    top: calc(var(--space-4) + 44px);
}

.hint-toast kbd {
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--bg-3);
    border: 1px solid var(--line);
    font-family: inherit;
    font-size: 11px;
}

.fade-enter-active, .fade-leave-active { transition: opacity 400ms var(--ease); }
.fade-enter-from, .fade-leave-to { opacity: 0; }

@media (max-width: 640px) {
    .title { font-size: 12px; }
}
</style>
