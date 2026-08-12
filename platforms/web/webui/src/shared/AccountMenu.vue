<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import {
    CircleHelp, Database, FolderOpen, Link as LinkIcon, LogOut, Menu, Settings, Shield, Trash2
} from '@lucide/vue';
import { api, accountLoginUrl } from './api.js';

defineProps({ cacheTools: { type: Boolean, default: false } });
const emit = defineEmits(['open-cache']);

const root = ref(null);
const loading = ref(true);
const user = ref(null);
const available = ref({ steam: true, github: false });
const showMenu = ref(false);
const showLogoutConfirm = ref(false);
const loggingOut = ref(false);
const logoutError = ref('');
const status = ref('');
const avatarFailed = ref(false);
const menuPosition = ref({});

const initial = computed(() => (user.value?.displayName || '?').trim().charAt(0).toUpperCase());
const showAvatar = computed(() => !!user.value?.avatarUrl && !avatarFailed.value);
const linked = (provider) => user.value?.providers?.includes(provider);

const ERROR_MESSAGES = {
    state_mismatch: '登录请求已失效，请重新尝试。',
    state_invalid: '登录请求无法验证，请重新尝试。',
    state_expired: '登录操作已超时，请重新尝试。',
    provider_denied: '登录已取消。',
    provider_exchange_failed: 'GitHub 没有完成授权，请稍后重试。',
    provider_verification_failed: 'Steam 身份验证失败，请稍后重试。',
    provider_profile_failed: '无法读取平台账号资料。',
    identity_in_use: '这个平台账号已经绑定到另一个 Kirikiroid2 账号。',
    provider_already_linked: '当前账号已经绑定了另一个同平台账号。',
    login_failed: '登录失败，请稍后重试。'
};

function returnTo() {
    return location.pathname + location.search + location.hash;
}

function beginAuth(provider, link = false) {
    if (!available.value[provider]) return;
    location.href = accountLoginUrl(provider, { returnTo: returnTo(), link });
}

function positionMenu() {
    const rect = root.value?.getBoundingClientRect();
    if (!rect) return;
    menuPosition.value = {
        top: `${Math.round(rect.bottom + 8)}px`,
        right: `${Math.max(12, Math.round(innerWidth - rect.right))}px`
    };
}

async function toggleMenu() {
    showMenu.value = !showMenu.value;
    if (showMenu.value) {
        await nextTick();
        positionMenu();
    }
}

function openCache() {
    showMenu.value = false;
    emit('open-cache');
}

async function refreshAccount() {
    try {
        const result = await api.getAccount();
        user.value = result.user || null;
        avatarFailed.value = false;
        available.value = result.availableProviders || available.value;
    } catch (err) {
        status.value = err.message || '无法读取登录状态';
    } finally {
        loading.value = false;
    }
}

function requestLogout() {
    showMenu.value = false;
    logoutError.value = '';
    showLogoutConfirm.value = true;
}

async function clearLocalSaves() {
    const idb = window.KrKr2IDB;
    if (!idb?.listSpaces || !idb?.deleteSpace) {
        throw new Error('当前浏览器无法读取本地存档');
    }
    await idb.whenIdle?.();
    const spaces = await idb.listSpaces();
    for (const spaceId of spaces) await idb.deleteSpace(spaceId);
}

async function logout(clearSaves = false) {
    if (loggingOut.value) return;
    loggingOut.value = true;
    logoutError.value = '';
    try {
        if (clearSaves) await clearLocalSaves();
        await api.logoutAccount();
        user.value = null;
        showMenu.value = false;
        showLogoutConfirm.value = false;
    } catch (err) {
        logoutError.value = err.message || '退出失败';
    } finally {
        loggingOut.value = false;
    }
}

function handleKeyDown(event) {
    if (event.key !== 'Escape') return;
    if (showLogoutConfirm.value && !loggingOut.value) {
        showLogoutConfirm.value = false;
        return;
    }
    showMenu.value = false;
}

function consumeAuthResult() {
    const url = new URL(location.href);
    const authError = url.searchParams.get('authError');
    if (authError) {
        status.value = ERROR_MESSAGES[authError] || ERROR_MESSAGES.login_failed;
        showMenu.value = true;
    }
    if (!authError && url.searchParams.get('authSuccess')) status.value = '';
    if (authError || url.searchParams.has('authSuccess')) {
        url.searchParams.delete('authError');
        url.searchParams.delete('authSuccess');
        history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
}

onMounted(async () => {
    consumeAuthResult();
    await refreshAccount();
    if (showMenu.value) await nextTick(positionMenu);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', positionMenu);
});

onUnmounted(() => {
    document.removeEventListener('keydown', handleKeyDown);
    window.removeEventListener('resize', positionMenu);
});
</script>

<template>
    <div ref="root" class="account-root">
        <span v-if="loading" class="account-loading" aria-label="正在读取登录状态" />

        <button
            v-else
            class="account-trigger"
            :class="{ guest: !user }"
            type="button"
            :aria-label="user ? '打开用户菜单' : '打开菜单'"
            :title="user ? '用户与工具' : '菜单'"
            :aria-expanded="showMenu"
            aria-haspopup="dialog"
            @click="toggleMenu">
            <template v-if="user">
                <span class="account-avatar" aria-hidden="true">
                    <img v-if="showAvatar" :src="user.avatarUrl" alt="" crossorigin="anonymous"
                        referrerpolicy="no-referrer" @error="avatarFailed = true">
                    <template v-else>{{ initial }}</template>
                </span>
                <span class="account-name">{{ user.displayName }}</span>
            </template>
            <Menu v-else :size="18" aria-hidden="true" />
        </button>
    </div>

    <Teleport to="body">
        <div v-if="showMenu" class="account-menu-backdrop" @click="showMenu = false" />
        <section
            v-if="showMenu"
            class="account-menu"
            :style="menuPosition"
            role="dialog"
            aria-modal="true"
            aria-label="用户与工具菜单">
            <div v-if="user" class="account-summary">
                    <span class="account-avatar large" aria-hidden="true">
                        <img v-if="showAvatar" :src="user.avatarUrl" alt="" crossorigin="anonymous"
                            referrerpolicy="no-referrer" @error="avatarFailed = true">
                        <template v-else>{{ initial }}</template>
                    </span>
                    <span>
                        <strong>{{ user.displayName }}</strong>
                        <small>
                            {{ user.providers.map((p) => p === 'steam' ? 'Steam' : 'GitHub').join(' · ') }}
                        </small>
                    </span>
            </div>
            <div v-else class="account-guest">
                <strong>登录 / 注册</strong>
                <small>登录可使用站点云存档；本地游玩和 WebDAV 无需登录。</small>
                <div class="provider-list">
                    <button class="provider-button" type="button" :disabled="!available.steam"
                        @click="beginAuth('steam')">
                        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <path d="M12 2a10 10 0 0 0-9.82 8.12l5.2 2.15a2.82 2.82 0 0 1 1.69-.56l2.31-3.35v-.05a3.76 3.76 0 1 1 3.76 3.76h-.08l-3.3 2.36a2.82 2.82 0 0 1-5.57.63L2.47 13.5A10 10 0 1 0 12 2Zm-3.66 14.5-1.2-.5a2.1 2.1 0 0 0 1.1 1.12 2.07 2.07 0 0 0 2.72-1.1 2.08 2.08 0 0 0-1.1-2.72 2.02 2.02 0 0 0-1.56-.03l1.24.51a1.53 1.53 0 1 1-1.2 2.82v-.1Zm6.8-5.69a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm0-.63a1.87 1.87 0 1 1 0-3.74 1.87 1.87 0 0 1 0 3.74Z" />
                        </svg>
                        <span>Steam</span>
                    </button>
                    <button class="provider-button" type="button" :disabled="!available.github"
                        @click="beginAuth('github')">
                        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <path d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2.02c-3.22.7-3.9-1.37-3.9-1.37-.52-1.34-1.28-1.7-1.28-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.57-.29-5.27-1.29-5.27-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.16 1.18A10.9 10.9 0 0 1 12 6.03c.98 0 1.95.13 2.87.39 2.2-1.49 3.16-1.18 3.16-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.4-2.71 5.38-5.29 5.67.42.36.78 1.07.78 2.16v3.34c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" />
                        </svg>
                        <span>GitHub</span>
                    </button>
                </div>
                <p v-if="status" class="account-status">{{ status }}</p>
            </div>

            <nav class="account-tools" aria-label="工具">
                <a class="account-menu-item" href="/settings">
                    <Settings :size="16" /><span>设置与存档同步</span>
                </a>
                <a class="account-menu-item" href="/help">
                    <CircleHelp :size="16" /><span>帮助与说明</span>
                </a>
                <button v-if="cacheTools" class="account-menu-item" type="button" @click="openCache">
                    <Database :size="16" /><span>本地缓存</span>
                </button>
                <a class="account-menu-item" href="/play/local">
                    <FolderOpen :size="16" /><span>打开本地文件</span>
                </a>
            </nav>

            <div v-if="user" class="account-actions">
                <button
                    v-if="!linked('steam') && available.steam"
                    class="account-menu-item"
                    type="button"
                    @click="beginAuth('steam', true)">
                    <LinkIcon :size="16" /><span>绑定 Steam</span>
                </button>
                <button
                    v-if="!linked('github') && available.github"
                    class="account-menu-item"
                    type="button"
                    @click="beginAuth('github', true)">
                    <LinkIcon :size="16" /><span>绑定 GitHub</span>
                </button>
                <button class="account-menu-item danger" type="button" @click="requestLogout">
                    <LogOut :size="16" /><span>退出登录</span>
                </button>
            </div>
            <a class="account-menu-item account-admin" href="/admin">
                <Shield :size="16" /><span>管理后台</span>
            </a>
        </section>

        <div
            v-if="showLogoutConfirm"
            class="logout-backdrop"
            @click.self="!loggingOut && (showLogoutConfirm = false)">
            <section
                class="logout-dialog"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="logout-title"
                aria-describedby="logout-description">
                <h2 id="logout-title">退出账号</h2>
                <p id="logout-description">要同时清空这台设备上的本地存档吗？</p>
                <p class="logout-warning">
                    清空后，尚未同步的进度无法恢复。远端存档、游戏下载缓存和外部游戏文件夹不会被删除。
                </p>
                <p v-if="logoutError" class="account-status">{{ logoutError }}</p>
                <div class="logout-actions">
                    <button class="btn btn-ghost" type="button" :disabled="loggingOut"
                        @click="showLogoutConfirm = false">
                        取消
                    </button>
                    <button class="btn btn-primary" type="button" :disabled="loggingOut"
                        @click="logout(false)">
                        <LogOut :size="15" aria-hidden="true" />
                        {{ loggingOut ? '正在退出' : '保留存档并退出' }}
                    </button>
                    <button class="btn btn-danger" type="button" :disabled="loggingOut"
                        @click="logout(true)">
                        <Trash2 :size="15" aria-hidden="true" />
                        清空存档并退出
                    </button>
                </div>
            </section>
        </div>
    </Teleport>
</template>

<style scoped>
.account-root { position: relative; flex: none; }

.account-loading {
    display: block;
    width: 32px;
    height: 32px;
    border-radius: var(--radius-sm);
    background: var(--bg-2);
}

.account-trigger {
    height: 32px;
    max-width: 190px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 3px 8px 3px 4px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--line);
    background: transparent;
    font-size: 12px;
    font-weight: 500;
}

.account-trigger.guest { width: 32px; justify-content: center; padding: 0; }

.account-trigger:hover { background: var(--bg-2); border-color: var(--line-strong); }

.account-avatar {
    width: 24px;
    height: 24px;
    flex: none;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: var(--fg-0);
    color: var(--bg-0);
    font-size: 11px;
    font-weight: 700;
    overflow: hidden;
}

.account-avatar img { display: block; width: 100%; height: 100%; object-fit: cover; }
.account-avatar.large { width: 34px; height: 34px; font-size: 13px; }

.account-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.account-menu {
    position: fixed;
    z-index: calc(var(--z-modal) + 1);
    width: 288px;
    max-height: calc(100dvh - 72px);
    overflow-y: auto;
    padding: 8px;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    background: var(--bg-1);
    box-shadow: var(--shadow);
}

.account-menu-backdrop { position: fixed; inset: 0; z-index: var(--z-modal); background: transparent; }

.account-summary {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 8px 12px;
    border-bottom: 1px solid var(--line);
    margin-bottom: 5px;
}

.account-guest { padding: 10px 8px 12px; border-bottom: 1px solid var(--line); margin-bottom: 5px; }
.account-guest > strong { display: block; margin-bottom: 4px; font-size: 13px; }
.account-guest > small { display: block; color: var(--fg-2); font-size: 10px; line-height: 1.5; }

.account-summary span:last-child { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.account-summary strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.account-summary small { color: var(--fg-2); font-size: 10px; }

.account-menu-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 34px;
    padding: 7px 9px;
    border-radius: 6px;
    text-align: left;
    font-size: 12px;
}

.account-menu-item:hover { background: var(--bg-2); }
.account-menu-item.danger { color: var(--danger); }
.account-tools + .account-actions { border-top: 1px solid var(--line); margin-top: 5px; padding-top: 5px; }
.account-admin { margin-top: 5px; border-top: 1px solid var(--line); border-radius: 0 0 6px 6px; color: var(--fg-2); }

.provider-list { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 10px; }

.provider-button {
    width: 100%;
    height: 38px;
    display: flex;
    justify-content: center;
    gap: 8px;
    align-items: center;
    padding: 0 14px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--line);
    background: var(--bg-2);
    font-size: 13px;
    font-weight: 600;
    transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease);
}

.provider-button svg { width: 20px; height: 20px; }
.provider-button:hover:not(:disabled) { background: var(--bg-3); border-color: var(--line-strong); }
.provider-button:disabled { opacity: 0.42; cursor: not-allowed; }

.account-status {
    margin: var(--space-3) 0 0;
    padding: 9px 10px;
    border-radius: var(--radius-sm);
    background: var(--danger-dim);
    color: var(--danger);
    font-size: 11px;
    line-height: 1.5;
}

.logout-backdrop {
    position: fixed;
    inset: 0;
    z-index: calc(var(--z-modal) + 2);
    display: grid;
    place-items: center;
    padding: var(--space-4);
    background: rgba(0, 0, 0, .72);
    backdrop-filter: blur(5px);
}

.logout-dialog {
    width: min(440px, 100%);
    padding: var(--space-5);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    background: var(--bg-1);
    box-shadow: var(--shadow-lg);
}

.logout-dialog h2 { margin: 0 0 var(--space-2); font-size: 17px; }
.logout-dialog > p { margin: 0; color: var(--fg-1); font-size: 13px; line-height: 1.6; }
.logout-dialog .logout-warning { margin-top: var(--space-3); color: var(--fg-2); font-size: 11px; }
.logout-actions {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-top: var(--space-5);
}

@media (max-width: 560px) {
    .account-name { display: none; }
    .account-trigger { width: 32px; padding: 3px; }
    .account-menu-backdrop { background: rgba(0, 0, 0, .66); backdrop-filter: blur(4px); }
    .account-menu {
        top: auto !important;
        right: 0 !important;
        bottom: 0;
        left: 0;
        width: 100%;
        max-height: min(82dvh, 620px);
        padding: 12px 12px max(12px, env(safe-area-inset-bottom));
        border-width: 1px 0 0;
        border-radius: var(--radius) var(--radius) 0 0;
        box-shadow: var(--shadow-lg);
    }
    .account-menu-item { min-height: 42px; padding: 9px 10px; }
    .logout-backdrop { align-items: end; padding: 0; }
    .logout-dialog {
        width: 100%;
        padding: var(--space-5) var(--space-4) max(var(--space-4), env(safe-area-inset-bottom));
        border-width: 1px 0 0;
        border-radius: var(--radius) var(--radius) 0 0;
    }
    .logout-actions { display: grid; grid-template-columns: 1fr; }
    .logout-actions .btn { justify-content: center; min-height: 42px; }
    .logout-actions .btn-primary { order: -1; }
}
</style>
