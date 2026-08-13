// 响应式全局确认对话框系统。
import { ref } from 'vue';

export const confirmState = ref(null);

export function showConfirm(options) {
    return new Promise((resolve) => {
        confirmState.value = {
            title: options.title || '确认操作',
            message: options.message || '',
            confirmText: options.confirmText || '确定',
            cancelText: options.cancelText || '取消',
            danger: !!options.danger,
            resolve: (val) => {
                confirmState.value = null;
                resolve(val);
            }
        };
    });
}
