// 轻量级全局提示（Toast）系统。
import { ref } from 'vue';

export const toasts = ref([]);

let nextId = 1;

export function showToast(message, type = 'info', duration = 3500) {
    const id = nextId++;
    const item = { id, message: String(message || ''), type, duration };
    toasts.value.push(item);
    if (duration > 0) {
        setTimeout(() => {
            removeToast(id);
        }, duration);
    }
    return id;
}

export function removeToast(id) {
    toasts.value = toasts.value.filter((t) => t.id !== id);
}

export const toast = {
    info: (msg, dur) => showToast(msg, 'info', dur),
    success: (msg, dur) => showToast(msg, 'success', dur),
    error: (msg, dur = 5000) => showToast(msg, 'error', dur),
    warn: (msg, dur = 4000) => showToast(msg, 'warn', dur)
};
