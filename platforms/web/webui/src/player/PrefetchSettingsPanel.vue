<script setup>
import { ref } from 'vue';

const props = defineProps({
    enabled: { type: Boolean, default: true },
    trace: { type: Boolean, default: false }
});

const emit = defineEmits(['close', 'apply']);
const enabled = ref(props.enabled);
const trace = ref(props.trace);
const traceCopyStatus = ref('');

function apply() {
    emit('apply', { enabled: enabled.value, trace: trace.value });
}

async function copyTraceLogs() {
    const records = window.__KRKR2_PREFETCH_LOGS__ || [];
    if (!records.length) {
        traceCopyStatus.value = '当前还没有诊断记录';
        return;
    }
    try {
        await navigator.clipboard.writeText(records.join('\n'));
        traceCopyStatus.value = `已复制最近 ${records.length} 条记录`;
    } catch (_) {
        traceCopyStatus.value = '复制失败，请在控制台读取 Info 级别日志';
    }
}
</script>

<template>
    <div class="backdrop" @click.self="emit('close')">
        <section class="panel" role="dialog" aria-modal="true" aria-labelledby="prefetch-settings-title">
            <header class="head">
                <div>
                    <h2 id="prefetch-settings-title">资源预加载</h2>
                    <p>设置会保存在当前浏览器中，应用后需要重新加载游戏。</p>
                </div>
                <button class="btn btn-ghost btn-sm" type="button" @click="emit('close')">关闭</button>
            </header>

            <label class="option">
                <span>
                    <strong>启用资源预加载</strong>
                    <small>提前扫描脚本中的立绘、背景、语音和 BGM。</small>
                </span>
                <input v-model="enabled" type="checkbox">
            </label>

            <label class="option">
                <span>
                    <strong>输出预加载诊断</strong>
                    <small>在控制台输出脚本行、资源队列、耗时和本地缓存命中情况。</small>
                </span>
                <input v-model="trace" type="checkbox">
            </label>

            <p class="hint">
                判断卡顿来源时，先保持诊断开启运行一次，再关闭“启用资源预加载”并从同一存档重试。
            </p>

            <div class="trace-actions">
                <button class="btn btn-ghost btn-sm" type="button" @click="copyTraceLogs">
                    复制最近诊断日志
                </button>
                <span v-if="traceCopyStatus">{{ traceCopyStatus }}</span>
            </div>

            <footer>
                <button class="btn" type="button" @click="emit('close')">取消</button>
                <button class="btn btn-primary" type="button" @click="apply">应用并重新加载</button>
            </footer>
        </section>
    </div>
</template>

<style scoped>
.backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--z-modal);
    display: grid;
    place-items: center;
    padding: var(--space-4);
    background: rgba(0, 0, 0, 0.72);
    backdrop-filter: blur(8px);
}

.panel {
    width: min(520px, 100%);
    padding: var(--space-5);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--bg-1);
    box-shadow: var(--shadow-lg);
}

.head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
}

.head h2 { margin: 0 0 4px; font-size: 16px; font-weight: 600; }
.head p, .hint {
    margin: 0;
    font-size: 12px;
    line-height: 1.65;
    color: var(--fg-1);
}

.option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-3);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--bg-2);
}

.option + .option { margin-top: var(--space-2); }
.option span { display: flex; flex-direction: column; gap: 3px; }
.option strong { font-size: 13px; font-weight: 500; }
.option small { font-size: 11px; line-height: 1.5; color: var(--fg-2); }
.option input { width: 20px; height: 20px; flex: 0 0 auto; accent-color: var(--fg-0); }
.hint { margin-top: var(--space-4); }
.trace-actions {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-top: var(--space-3);
}
.trace-actions span { font-size: 11px; color: var(--fg-2); }

footer {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    margin-top: var(--space-5);
}
</style>
