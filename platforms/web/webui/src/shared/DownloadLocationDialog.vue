<script setup>
import { Download, FolderOpen, HardDrive } from '@lucide/vue';
import { ref } from 'vue';

const dontAskAgain = ref(false);

defineEmits(['cancel', 'select-folder', 'use-browser']);
</script>

<template>
    <Teleport to="body">
        <div class="download-location-backdrop">
            <section
                class="download-location-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="download-location-title"
                aria-describedby="download-location-description">
                <span class="download-location-icon" aria-hidden="true">
                    <Download :size="20" />
                </span>
                <div class="download-location-content">
                    <h2 id="download-location-title">选择游戏下载位置</h2>
                    <p id="download-location-description">
                        建议保存到自己的文件夹。游戏会作为普通文件长期保留，
                        不会因浏览器清理缓存或设备空间紧张而丢失，也方便拷贝和备份。
                    </p>
                    <p class="download-location-warning">
                        浏览器内部存储无需授权，但可能被系统或“清除浏览数据”删除。
                    </p>
                    <label class="download-location-choice">
                        <input v-model="dontAskAgain" type="checkbox">
                        <span>
                            <strong>以后不再提示</strong>
                            <small>选择“存浏览器里”后，今后的完整下载将直接使用浏览器内部存储。</small>
                        </span>
                    </label>
                </div>
                <div class="download-location-actions">
                    <button class="btn btn-ghost" type="button" @click="$emit('cancel')">
                        取消下载
                    </button>
                    <button class="btn" type="button" @click="$emit('use-browser', dontAskAgain)">
                        <HardDrive :size="16" aria-hidden="true" />
                        存浏览器里
                    </button>
                    <button class="btn btn-primary" type="button" @click="$emit('select-folder')">
                        <FolderOpen :size="16" aria-hidden="true" />
                        选择文件夹
                    </button>
                </div>
                <p class="download-location-settings">之后可在“设置”或“本地缓存”中更改。</p>
            </section>
        </div>
    </Teleport>
</template>

<style scoped>
.download-location-backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--z-modal);
    display: grid;
    place-items: center;
    padding: var(--space-4);
    background: rgba(0, 0, 0, 0.68);
    backdrop-filter: blur(6px);
}

.download-location-dialog {
    width: min(510px, 100%);
    display: grid;
    grid-template-columns: 38px minmax(0, 1fr);
    gap: var(--space-3);
    padding: var(--space-4);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    background: var(--bg-1);
    box-shadow: var(--shadow);
}

.download-location-icon {
    width: 38px;
    height: 38px;
    display: grid;
    place-items: center;
    border-radius: var(--radius-sm);
    background: var(--bg-3);
    color: var(--fg-0);
}

.download-location-content { min-width: 0; }
.download-location-content h2 { margin: 1px 0 var(--space-2); font-size: 16px; }
.download-location-content p { margin: 0; color: var(--fg-1); font-size: 13px; line-height: 1.65; }
.download-location-content .download-location-warning {
    margin-top: var(--space-2);
    color: var(--fg-2);
    font-size: 11px;
}

.download-location-choice {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin-top: var(--space-4);
    padding: 11px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--bg-2);
    cursor: pointer;
}

.download-location-choice input {
    width: 17px;
    height: 17px;
    flex: none;
    margin: 1px 0 0;
    accent-color: var(--accent);
}

.download-location-choice span { display: flex; flex-direction: column; gap: 3px; }
.download-location-choice strong { font-size: 12px; font-weight: 600; }
.download-location-choice small { color: var(--fg-2); font-size: 10px; line-height: 1.5; }

.download-location-actions {
    grid-column: 1 / -1;
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    margin-top: var(--space-1);
}

.download-location-settings {
    grid-column: 1 / -1;
    margin: -2px 0 0;
    color: var(--fg-2);
    font-size: 10px;
    text-align: right;
}

@media (max-width: 520px) {
    .download-location-dialog { grid-template-columns: 32px minmax(0, 1fr); }
    .download-location-icon { width: 32px; height: 32px; }
    .download-location-actions { display: grid; grid-template-columns: 1fr 1fr; }
    .download-location-actions .btn { justify-content: center; }
    .download-location-actions .btn-primary { grid-column: 1 / -1; grid-row: 1; }
    .download-location-settings { text-align: left; }
}
</style>
