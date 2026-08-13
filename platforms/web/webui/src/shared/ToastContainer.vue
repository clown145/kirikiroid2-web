<script setup>
import { toasts, removeToast } from './toast.js';
import { AlertCircle, CheckCircle2, Info, TriangleAlert, X } from '@lucide/vue';
</script>

<template>
    <Teleport to="body">
        <div class="toast-container" aria-live="polite" aria-atomic="true">
            <TransitionGroup name="toast">
                <div
                    v-for="t in toasts"
                    :key="t.id"
                    class="toast-item"
                    :class="t.type"
                    role="alert">
                    <span class="toast-icon" aria-hidden="true">
                        <CheckCircle2 v-if="t.type === 'success'" :size="16" />
                        <AlertCircle v-else-if="t.type === 'error'" :size="16" />
                        <TriangleAlert v-else-if="t.type === 'warn'" :size="16" />
                        <Info v-else :size="16" />
                    </span>
                    <span class="toast-message">{{ t.message }}</span>
                    <button
                        type="button"
                        class="toast-close"
                        aria-label="关闭提示"
                        @click="removeToast(t.id)">
                        <X :size="14" aria-hidden="true" />
                    </button>
                </div>
            </TransitionGroup>
        </div>
    </Teleport>
</template>

<style scoped>
.toast-container {
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    z-index: calc(var(--z-modal) + 50);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    pointer-events: none;
    max-width: min(90vw, 420px);
    width: 100%;
}

.toast-item {
    pointer-events: auto;
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--line-strong);
    background: rgba(18, 18, 20, 0.94);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    box-shadow: var(--shadow);
    color: var(--fg-0);
    font-size: 13px;
    line-height: 1.5;
    word-break: break-word;
}

.toast-icon {
    flex: none;
    display: grid;
    place-items: center;
}

.toast-item.info .toast-icon { color: var(--fg-1); }
.toast-item.success .toast-icon { color: #6ee7a8; }
.toast-item.warn .toast-icon { color: #fbbf24; }
.toast-item.error .toast-icon { color: var(--danger); }
.toast-item.error { border-color: rgba(248, 113, 113, 0.35); background: rgba(24, 14, 14, 0.94); }

.toast-message {
    flex: 1;
    min-width: 0;
}

.toast-close {
    flex: none;
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border-radius: 4px;
    color: var(--fg-2);
    cursor: pointer;
    transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}

.toast-close:hover {
    color: var(--fg-0);
    background: var(--bg-3);
}

.toast-enter-active, .toast-leave-active {
    transition: all var(--dur) var(--ease);
}

.toast-enter-from {
    opacity: 0;
    transform: translateY(-12px) scale(0.95);
}

.toast-leave-to {
    opacity: 0;
    transform: translateY(-8px) scale(0.95);
}
</style>
