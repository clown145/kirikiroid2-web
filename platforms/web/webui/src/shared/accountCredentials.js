import { ref } from 'vue';

// 与全局确认框相同的调用方式，让账号菜单、同步面板和设置页共用一个弹窗。
export const accountCredentialsState = ref(null);

export function openAccountCredentials(mode = 'login', options = {}) {
    accountCredentialsState.value = {
        mode,
        ...options,
        key: crypto.randomUUID()
    };
}

export function closeAccountCredentials() {
    accountCredentialsState.value = null;
}

export function notifyAccountChanged(user = null) {
    window.dispatchEvent(new CustomEvent('krkr2:account-changed', { detail: { user } }));
}
