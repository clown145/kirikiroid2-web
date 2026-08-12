<script setup>
import { FolderOpen, TriangleAlert } from '@lucide/vue';

defineProps({
    folderName: { type: String, default: '' },
    restoring: { type: Boolean, default: false },
    error: { type: String, default: '' },
    blocking: { type: Boolean, default: false }
});

defineEmits(['restore', 'ignore', 'unbind']);
</script>

<template>
    <div class="folder-permission-backdrop">
        <section
            class="folder-permission-dialog"
            :class="{ blocking }"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="folder-permission-title"
            aria-describedby="folder-permission-description">
            <span class="folder-permission-icon" aria-hidden="true">
                <TriangleAlert :size="20" />
            </span>
            <div class="folder-permission-content">
                <h2 id="folder-permission-title">需要重新授权文件夹</h2>
                <p id="folder-permission-description">
                    无法访问已绑定的游戏下载文件夹
                    <strong v-if="folderName">“{{ folderName }}”</strong>。
                    <template v-if="blocking">
                        恢复访问或解除绑定后，才能启动当前游戏。
                    </template>
                    <template v-else>
                        恢复访问后会继续使用原文件夹和已有下载进度。
                    </template>
                </p>
                <p class="folder-permission-note">
                    解除绑定不会删除磁盘上的文件；之后将使用浏览器内部存储或远程游戏源。
                </p>
                <p v-if="error" class="folder-permission-error">{{ error }}</p>
            </div>
            <div class="folder-permission-actions">
                <button v-if="!blocking" class="btn btn-ghost" type="button" :disabled="restoring" @click="$emit('ignore')">
                    暂时忽略
                </button>
                <button class="btn btn-danger" type="button" :disabled="restoring" @click="$emit('unbind')">
                    解除绑定
                </button>
                <button class="btn btn-primary" type="button" :disabled="restoring" @click="$emit('restore')">
                    <FolderOpen :size="16" aria-hidden="true" />
                    {{ restoring ? '正在恢复' : '恢复访问' }}
                </button>
            </div>
        </section>
    </div>
</template>

<style scoped>
.folder-permission-backdrop {
    position: fixed;
    inset: 0;
    z-index: calc(var(--z-modal) + 3);
    display: grid;
    place-items: center;
    padding: var(--space-4);
    background: rgba(0, 0, 0, 0.68);
    backdrop-filter: blur(6px);
}

.folder-permission-dialog {
    width: min(440px, 100%);
    display: grid;
    grid-template-columns: 38px minmax(0, 1fr);
    gap: var(--space-3);
    padding: var(--space-4);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    background: var(--bg-1);
    box-shadow: var(--shadow);
}

.folder-permission-icon {
    width: 38px;
    height: 38px;
    display: grid;
    place-items: center;
    border-radius: var(--radius-sm);
    background: var(--danger-dim);
    color: var(--danger);
}

.folder-permission-content { min-width: 0; }
.folder-permission-content h2 { margin: 1px 0 var(--space-2); font-size: 16px; }
.folder-permission-content p { margin: 0; color: var(--fg-1); font-size: 13px; line-height: 1.65; }
.folder-permission-content strong { color: var(--fg-0); font-weight: 600; overflow-wrap: anywhere; }
.folder-permission-content .folder-permission-note { margin-top: var(--space-2); color: var(--fg-2); font-size: 11px; }
.folder-permission-content .folder-permission-error { margin-top: var(--space-3); color: var(--danger); }

.folder-permission-actions {
    grid-column: 1 / -1;
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    margin-top: var(--space-1);
}

@media (max-width: 460px) {
    .folder-permission-dialog { grid-template-columns: 32px minmax(0, 1fr); }
    .folder-permission-icon { width: 32px; height: 32px; }
    .folder-permission-actions { display: grid; grid-template-columns: 1fr 1fr; }
    .folder-permission-actions .btn { justify-content: center; }
    .folder-permission-actions .btn-primary { grid-column: 1 / -1; grid-row: 2; }
    .folder-permission-dialog.blocking .folder-permission-actions .btn-danger {
        grid-column: 1 / -1;
    }
}
</style>
