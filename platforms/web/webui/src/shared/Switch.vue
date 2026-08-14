<script setup>
import { computed } from 'vue';

const props = defineProps({
    modelValue: {
        type: Boolean,
        default: false
    },
    disabled: {
        type: Boolean,
        default: false
    },
    size: {
        type: String,
        default: 'md',
        validator: (v) => ['sm', 'md', 'lg'].includes(v)
    },
    ariaLabel: {
        type: String,
        default: ''
    }
});

const emit = defineEmits(['update:modelValue', 'change']);

function toggle() {
    if (props.disabled) return;
    const next = !props.modelValue;
    emit('update:modelValue', next);
    emit('change', next);
}

function handleKeydown(event) {
    if (props.disabled) return;
    if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        toggle();
    }
}
</script>

<template>
    <button
        type="button"
        role="switch"
        class="krkr-switch"
        :class="[`size-${size}`, { active: modelValue, disabled }]"
        :aria-checked="modelValue"
        :aria-label="ariaLabel"
        :disabled="disabled"
        tabindex="0"
        @click="toggle"
        @keydown="handleKeydown">
        <input
            type="checkbox"
            :checked="modelValue"
            :disabled="disabled"
            tabindex="-1"
            style="display: none;"
            aria-hidden="true">
        <span class="krkr-switch-track">
            <span class="krkr-switch-thumb" />
        </span>
    </button>
</template>

<style scoped>
.krkr-switch {
    display: inline-flex;
    align-items: center;
    padding: 0;
    margin: 0;
    border: none;
    background: transparent;
    cursor: pointer;
    user-select: none;
    flex-shrink: 0;
    outline: none;
}

.krkr-switch:disabled,
.krkr-switch.disabled {
    opacity: 0.45;
    cursor: not-allowed;
}

.krkr-switch-track {
    position: relative;
    display: inline-block;
    border-radius: 9999px;
    background-color: var(--bg-3);
    border: 1px solid var(--line-strong);
    transition: background-color var(--dur) var(--ease),
                border-color var(--dur) var(--ease),
                box-shadow var(--dur) var(--ease);
}

.krkr-switch-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    border-radius: 50%;
    background-color: var(--fg-2);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
    transition: transform var(--dur) var(--ease),
                background-color var(--dur) var(--ease);
}

/* 尺寸规范 */
.krkr-switch.size-sm .krkr-switch-track {
    width: 30px;
    height: 18px;
}
.krkr-switch.size-sm .krkr-switch-thumb {
    width: 12px;
    height: 12px;
}
.krkr-switch.size-sm.active .krkr-switch-thumb {
    transform: translateX(12px);
}

.krkr-switch.size-md .krkr-switch-track {
    width: 38px;
    height: 22px;
}
.krkr-switch.size-md .krkr-switch-thumb {
    width: 16px;
    height: 16px;
}
.krkr-switch.size-md.active .krkr-switch-thumb {
    transform: translateX(16px);
}

.krkr-switch.size-lg .krkr-switch-track {
    width: 46px;
    height: 26px;
}
.krkr-switch.size-lg .krkr-switch-thumb {
    width: 20px;
    height: 20px;
}
.krkr-switch.size-lg.active .krkr-switch-thumb {
    transform: translateX(20px);
}

/* 悬浮与激活态 */
.krkr-switch:not(.disabled):hover .krkr-switch-thumb {
    background-color: var(--fg-1);
}

.krkr-switch.active .krkr-switch-track {
    background-color: var(--fg-0);
    border-color: var(--fg-0);
}

.krkr-switch.active .krkr-switch-thumb {
    background-color: var(--bg-0);
}

.krkr-switch.active:not(.disabled):hover .krkr-switch-thumb {
    background-color: var(--bg-1);
}

.krkr-switch:focus-visible .krkr-switch-track {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
}
</style>
