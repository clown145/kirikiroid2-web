<script setup>
import { ArrowLeft } from '@lucide/vue';
</script>

<template>
    <a class="back-to-gallery" href="/" aria-label="返回游戏库" title="返回游戏库">
        <ArrowLeft :size="16" aria-hidden="true" />
        <span>游戏库</span>
    </a>
</template>

<style scoped>
.back-to-gallery {
    min-height: 32px;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 5px 9px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    color: var(--fg-1);
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    transition: color var(--dur) var(--ease),
                background var(--dur) var(--ease),
                border-color var(--dur) var(--ease);
}

.back-to-gallery:hover {
    color: var(--fg-0);
    background: var(--bg-2);
    border-color: var(--line-strong);
}
</style>
