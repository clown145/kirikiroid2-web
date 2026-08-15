<script setup>
import { Check, Droplet, FolderOpen, HardDrive, Sparkles, Zap } from '@lucide/vue';
import { onMounted, ref } from 'vue';
import { getSetting, setSetting } from './settings.js';
import { toast } from './toast.js';

const emit = defineEmits(['close', 'complete']);

const selectedMode = ref(getSetting('playWhileDownloading') ? 'stream' : 'ondemand');
const storage = ref(null);
const binding = ref(false);
const supported = ref(typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function');

async function checkStorage() {
    if (!window.KrKr2Cache) return;
    try {
        storage.value = await window.KrKr2Cache.storageInfo();
    } catch {
        // 存储信息读取失败时不阻碍流程
    }
}

async function selectFolder() {
    if (binding.value || !window.KrKr2Cache) return;
    binding.value = true;
    try {
        const name = await window.KrKr2Cache.bindFolder();
        await checkStorage();
        if (name) {
            toast.success(`已绑定文件夹：${name}`);
        }
    } catch (err) {
        if (err?.name !== 'AbortError') {
            toast.error('绑定文件夹失败：' + (err?.message || err));
        }
    } finally {
        binding.value = false;
    }
}

function dismiss() {
    try {
        localStorage.setItem('krkr2-onboarding-dismissed', '1');
    } catch {}
    emit('close');
}

function complete() {
    try {
        localStorage.setItem('krkr2-onboarding-dismissed', '1');
    } catch {}
    const isStream = selectedMode.value === 'stream';
    setSetting('playWhileDownloading', isStream);
    toast.success(isStream ? '已开启边下边玩（流畅模式）' : '已选择纯按需读取（省流模式）');
    emit('complete', { mode: selectedMode.value });
}

onMounted(() => {
    checkStorage();
});
</script>

<template>
    <Teleport to="body">
        <div
            class="onboarding-backdrop"
            data-account-credentials-blocker
            @click.self="dismiss">
            <section
                class="onboarding-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="onboarding-title">
                <header class="onboarding-head">
                    <div class="onboarding-badge">
                        <Sparkles :size="14" aria-hidden="true" />
                        <span>快速初始化</span>
                    </div>
                    <h2 id="onboarding-title">欢迎体验 Kirikiroid2 Web</h2>
                    <p>建议完成以下 2 项基础设置，以获得接近原生客户端的最佳游玩体验：</p>
                </header>

                <div class="onboarding-sections">
                    <!-- 步骤 1：存储位置 -->
                    <section class="onboarding-step" aria-labelledby="step-storage-title">
                        <div class="step-header">
                            <span class="step-num">1</span>
                            <div>
                                <h3 id="step-storage-title">游戏存储位置</h3>
                                <p>存放完整下载的游戏与缓存素材。</p>
                            </div>
                        </div>

                        <div class="step-card storage-card">
                            <div class="storage-state">
                                <div class="storage-state-info">
                                    <template v-if="storage?.kind === 'folder' && storage.name">
                                        <div class="folder-bound-tag">
                                            <Check :size="14" aria-hidden="true" />
                                            <span>已绑定本地文件夹：<strong>{{ storage.name }}</strong></span>
                                        </div>
                                        <p class="step-desc success">游戏文件将作为实体文件保存在该目录下，安全不丢失。</p>
                                    </template>
                                    <template v-else>
                                        <div class="folder-unbound-tag">
                                            <HardDrive :size="14" aria-hidden="true" />
                                            <span>当前使用：<strong>浏览器内部存储</strong></span>
                                        </div>
                                        <p class="step-desc">
                                            浏览器内部存储可能在清理缓存或设备空间不足时被系统删除；绑定本地文件夹后文件永久保存，永不丢失且方便拷贝备份。
                                        </p>
                                    </template>
                                </div>

                                <button
                                    v-if="supported"
                                    type="button"
                                    class="btn btn-sm btn-action"
                                    :class="{ 'btn-primary': storage?.kind !== 'folder' }"
                                    :disabled="binding"
                                    @click="selectFolder">
                                    <FolderOpen :size="15" aria-hidden="true" />
                                    <span>{{ storage?.kind === 'folder' ? '更换文件夹' : '选择本地文件夹' }}</span>
                                </button>
                            </div>
                        </div>
                    </section>

                    <!-- 步骤 2：加载模式 -->
                    <section class="onboarding-step" aria-labelledby="step-mode-title">
                        <div class="step-header">
                            <span class="step-num">2</span>
                            <div>
                                <h3 id="step-mode-title">游戏加载模式</h3>
                                <p>控制游玩过程中如何获取剧本、立绘与语音资源。</p>
                            </div>
                        </div>

                        <div class="mode-options" role="radiogroup" aria-label="游戏加载模式">
                            <!-- 选项 A：边下边玩（推荐） -->
                            <label
                                class="mode-card"
                                :class="{ active: selectedMode === 'stream' }">
                                <div class="mode-card-radio">
                                    <input
                                        v-model="selectedMode"
                                        type="radio"
                                        name="onboarding-mode"
                                        value="stream">
                                </div>
                                <div class="mode-card-content">
                                    <div class="mode-card-title">
                                        <div class="mode-title-wrap">
                                            <Zap :size="16" class="icon-zap" aria-hidden="true" />
                                            <strong>边下边玩 · 流畅模式</strong>
                                        </div>
                                        <span class="recommend-badge">推荐</span>
                                    </div>
                                    <p class="mode-desc">
                                        进入游戏秒开，并在后台自动预载剩余章节与素材。彻底消除剧情翻页和语音加载等待，游玩后自动保留完整离线版。（适合 Wi-Fi / 宽带环境）
                                    </p>
                                </div>
                            </label>

                            <!-- 选项 B：纯按需读取（省流） -->
                            <label
                                class="mode-card"
                                :class="{ active: selectedMode === 'ondemand' }">
                                <div class="mode-card-radio">
                                    <input
                                        v-model="selectedMode"
                                        type="radio"
                                        name="onboarding-mode"
                                        value="ondemand">
                                </div>
                                <div class="mode-card-content">
                                    <div class="mode-card-title">
                                        <div class="mode-title-wrap">
                                            <Droplet :size="16" class="icon-droplet" aria-hidden="true" />
                                            <strong>纯按需读取 · 省流模式</strong>
                                        </div>
                                    </div>
                                    <p class="mode-desc">
                                        读到哪段剧情才实时下载当前资源，最省流量；但初次经过新场景或弱网时可能会有短暂加载等待。（适合移动蜂窝流量计费环境）
                                    </p>
                                </div>
                            </label>
                        </div>
                    </section>
                </div>

                <footer class="onboarding-foot">
                    <p class="onboarding-note">以上选项随时可在页面右上角「设置」中更改。</p>
                    <div class="onboarding-actions">
                        <button type="button" class="btn btn-ghost" @click="dismiss">
                            稍后再说，去挑游戏
                        </button>
                        <button type="button" class="btn btn-primary" @click="complete">
                            完成设置，进入游戏库
                        </button>
                    </div>
                </footer>
            </section>
        </div>
    </Teleport>
</template>

<style scoped>
.onboarding-backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--z-modal);
    display: grid;
    place-items: center;
    padding: var(--space-4);
    background: rgba(0, 0, 0, 0.72);
    backdrop-filter: blur(8px);
}

.onboarding-dialog {
    width: min(580px, 100%);
    max-height: calc(100vh - 48px);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    padding: var(--space-5) var(--space-6);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-lg);
    background: var(--bg-1);
    box-shadow: var(--shadow-lg);
}

.onboarding-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
}

.onboarding-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    align-self: flex-start;
    padding: 2px 10px;
    border-radius: 999px;
    background: var(--bg-3);
    border: 1px solid var(--line);
    color: var(--fg-0);
    font-size: 11px;
    font-weight: 500;
}

.onboarding-head h2 {
    margin: 0;
    color: var(--fg-0);
    font-size: 20px;
    font-weight: 600;
    letter-spacing: -0.02em;
}

.onboarding-head p {
    margin: 0;
    color: var(--fg-1);
    font-size: 13px;
    line-height: 1.5;
}

.onboarding-sections {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
}

.onboarding-step {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
}

.step-header {
    display: flex;
    align-items: center;
    gap: var(--space-3);
}

.step-num {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--bg-3);
    border: 1px solid var(--line-strong);
    color: var(--fg-0);
    font-size: 12px;
    font-weight: 600;
    display: grid;
    place-items: center;
    flex-shrink: 0;
}

.step-header h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--fg-0);
}

.step-header p {
    margin: 0;
    font-size: 12px;
    color: var(--fg-2);
}

.step-card {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--bg-2);
    padding: var(--space-3) var(--space-4);
}

.storage-state {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
}

.storage-state-info {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
}

.folder-bound-tag, .folder-unbound-tag {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--fg-0);
}

.folder-bound-tag {
    color: #4ade80;
}

.folder-bound-tag strong, .folder-unbound-tag strong {
    font-weight: 600;
    color: var(--fg-0);
}

.step-desc {
    margin: 0;
    font-size: 12px;
    color: var(--fg-1);
    line-height: 1.5;
}

.step-desc.success {
    color: var(--fg-1);
}

.btn-action {
    flex-shrink: 0;
    white-space: nowrap;
}

.mode-options {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
}

.mode-card {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--bg-2);
    cursor: pointer;
    transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}

.mode-card:hover {
    background: var(--bg-3);
    border-color: var(--line-strong);
}

.mode-card.active {
    background: var(--bg-3);
    border-color: var(--accent);
}

.mode-card-radio {
    margin-top: 3px;
}

.mode-card-radio input[type="radio"] {
    accent-color: var(--fg-0);
    cursor: pointer;
}

.mode-card-content {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
    min-width: 0;
}

.mode-card-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
}

.mode-title-wrap {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--fg-0);
    font-size: 13px;
}

.icon-zap {
    color: #facc15;
}

.icon-droplet {
    color: #60a5fa;
}

.recommend-badge {
    padding: 1px 6px;
    border-radius: 4px;
    background: rgba(250, 204, 21, 0.15);
    color: #fde047;
    border: 1px solid rgba(250, 204, 21, 0.3);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
}

.mode-desc {
    margin: 0;
    font-size: 12px;
    color: var(--fg-1);
    line-height: 1.5;
}

.onboarding-foot {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding-top: var(--space-2);
    border-top: 1px solid var(--line);
}

.onboarding-note {
    margin: 0;
    font-size: 11px;
    color: var(--fg-2);
    text-align: center;
}

.onboarding-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-2);
}

@media (max-width: 600px) {
    .onboarding-dialog {
        padding: var(--space-4);
    }
    .storage-state {
        flex-direction: column;
        align-items: flex-start;
    }
    .btn-action {
        width: 100%;
        justify-content: center;
    }
    .onboarding-actions {
        flex-direction: column-reverse;
        width: 100%;
    }
    .onboarding-actions button {
        width: 100%;
        justify-content: center;
    }
}
</style>
