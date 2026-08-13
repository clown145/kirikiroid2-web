<script setup>
import { confirmState } from './dialog.js';
import { TriangleAlert } from '@lucide/vue';
import { onMounted, onUnmounted } from 'vue';

function onCancel() {
    confirmState.value?.resolve(false);
}

function onConfirm() {
    confirmState.value?.resolve(true);
}

function onKeydown(e) {
    if (!confirmState.value) return;
    if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
    }
}

onMounted(() => {
    window.addEventListener('keydown', onKeydown);
});

onUnmounted(() => {
    window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
    <Teleport to="body">
        <Transition name="fade">
            <div
                v-if="confirmState"
                class="confirm-backdrop"
                @click.self="onCancel">
                <section
                    class="confirm-dialog"
                    role="alertdialog"
                    aria-modal="true"
                    aria-labelledby="confirm-title"
                    aria-describedby="confirm-message">
                    <header class="confirm-head">
                        <span v-if="confirmState.danger" class="confirm-icon danger" aria-hidden="true">
                            <TriangleAlert :size="18" />
                        </span>
                        <h2 id="confirm-title">{{ confirmState.title }}</h2>
                    </header>
                    <p id="confirm-message" class="confirm-message">{{ confirmState.message }}</p>
                    <div class="confirm-actions">
                        <button class="btn btn-ghost" type="button" @click="onCancel">
                            {{ confirmState.cancelText }}
                        </button>
                        <button
                            class="btn"
                            :class="confirmState.danger ? 'btn-danger' : 'btn-primary'"
                            type="button"
                            autofocus
                            @click="onConfirm">
                            {{ confirmState.confirmText }}
                        </button>
                    </div>
                </section>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
.confirm-backdrop {
    position: fixed;
    inset: 0;
    z-index: calc(var(--z-modal) + 40);
    display: grid;
    place-items: center;
    padding: var(--space-4);
    background: rgba(0, 0, 0, 0.72);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
}

.confirm-dialog {
    width: min(440px, 100%);
    padding: var(--space-5);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    background: var(--bg-1);
    box-shadow: var(--shadow-lg);
}

.confirm-head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: var(--space-2);
}

.confirm-head h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
}

.confirm-icon.danger {
    color: var(--danger);
    display: grid;
    place-items: center;
}

.confirm-message {
    margin: 0 0 var(--space-5);
    color: var(--fg-1);
    font-size: 13px;
    line-height: 1.65;
    white-space: pre-wrap;
}

.confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
}

.fade-enter-active, .fade-leave-active {
    transition: opacity var(--dur) var(--ease);
}

.fade-enter-from, .fade-leave-to {
    opacity: 0;
}
</style>
