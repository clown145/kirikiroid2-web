<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api, accountLoginUrl } from './api.js';

const root = ref(null);
const loading = ref(true);
const user = ref(null);
const available = ref({ steam: true, github: false });
const showLogin = ref(false);
const showMenu = ref(false);
const status = ref('');
const avatarFailed = ref(false);

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

async function logout() {
    try {
        await api.logoutAccount();
        user.value = null;
        showMenu.value = false;
    } catch (err) {
        status.value = err.message || '退出失败';
    }
}

function handleDocumentPointerDown(event) {
    if (root.value && !root.value.contains(event.target)) showMenu.value = false;
}

function handleKeyDown(event) {
    if (event.key !== 'Escape') return;
    showMenu.value = false;
    showLogin.value = false;
}

function consumeAuthResult() {
    const url = new URL(location.href);
    const authError = url.searchParams.get('authError');
    if (authError) {
        status.value = ERROR_MESSAGES[authError] || ERROR_MESSAGES.login_failed;
        showLogin.value = true;
    }
    if (!authError && url.searchParams.get('authSuccess')) status.value = '';
    if (authError || url.searchParams.has('authSuccess')) {
        url.searchParams.delete('authError');
        url.searchParams.delete('authSuccess');
        history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
}

onMounted(() => {
    consumeAuthResult();
    refreshAccount();
    document.addEventListener('pointerdown', handleDocumentPointerDown);
    document.addEventListener('keydown', handleKeyDown);
});

onUnmounted(() => {
    document.removeEventListener('pointerdown', handleDocumentPointerDown);
    document.removeEventListener('keydown', handleKeyDown);
});
</script>

<template>
    <div ref="root" class="account-root">
        <span v-if="loading" class="account-loading" aria-label="正在读取登录状态" />

        <button
            v-else-if="!user"
            class="btn btn-ghost btn-sm account-login-trigger"
            type="button"
            @click="showLogin = true">
            登录
        </button>

        <template v-else>
            <button
                class="account-trigger"
                type="button"
                :aria-expanded="showMenu"
                aria-haspopup="menu"
                @click="showMenu = !showMenu">
                <span class="account-avatar" aria-hidden="true">
                    <img v-if="showAvatar" :src="user.avatarUrl" alt="" crossorigin="anonymous"
                        referrerpolicy="no-referrer" @error="avatarFailed = true">
                    <template v-else>{{ initial }}</template>
                </span>
                <span class="account-name">{{ user.displayName }}</span>
                <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14" aria-hidden="true">
                    <path d="m7 10 5 5 5-5z" />
                </svg>
            </button>

            <div v-if="showMenu" class="account-menu" role="menu">
                <div class="account-summary">
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

                <button
                    v-if="!linked('steam') && available.steam"
                    class="account-menu-item"
                    role="menuitem"
                    type="button"
                    @click="beginAuth('steam', true)">
                    绑定 Steam
                </button>
                <button
                    v-if="!linked('github') && available.github"
                    class="account-menu-item"
                    role="menuitem"
                    type="button"
                    @click="beginAuth('github', true)">
                    绑定 GitHub
                </button>
                <button class="account-menu-item danger" role="menuitem" type="button" @click="logout">
                    退出登录
                </button>
            </div>
        </template>
    </div>

    <Teleport to="body">
        <div v-if="showLogin" class="account-backdrop" @click.self="showLogin = false">
            <section class="account-panel" role="dialog" aria-modal="true" aria-labelledby="account-title">
                <header class="account-panel-head">
                    <div>
                        <h2 id="account-title">登录 / 注册</h2>
                        <p>登录后可在不同设备间同步云存档。</p>
                    </div>
                    <button class="account-close" type="button" aria-label="关闭" @click="showLogin = false">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true">
                            <path d="M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.59 13.41 4.29 19.71 2.88 18.29 9.17 12 2.88 5.71 4.29 4.29 10.59 10.59 16.89 4.29z" />
                        </svg>
                    </button>
                </header>

                <div class="provider-list">
                    <button
                        class="provider-button"
                        type="button"
                        :disabled="!available.steam"
                        @click="beginAuth('steam')">
                        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <path d="M12 2a10 10 0 0 0-9.82 8.12l5.2 2.15a2.82 2.82 0 0 1 1.69-.56l2.31-3.35v-.05a3.76 3.76 0 1 1 3.76 3.76h-.08l-3.3 2.36a2.82 2.82 0 0 1-5.57.63L2.47 13.5A10 10 0 1 0 12 2Zm-3.66 14.5-1.2-.5a2.1 2.1 0 0 0 1.1 1.12 2.07 2.07 0 0 0 2.72-1.1 2.08 2.08 0 0 0-1.1-2.72 2.02 2.02 0 0 0-1.56-.03l1.24.51a1.53 1.53 0 1 1-1.2 2.82v-.1Zm6.8-5.69a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm0-.63a1.87 1.87 0 1 1 0-3.74 1.87 1.87 0 0 1 0 3.74Z" />
                        </svg>
                        <span>使用 Steam 登录</span>
                    </button>

                    <button
                        class="provider-button"
                        type="button"
                        :disabled="!available.github"
                        @click="beginAuth('github')">
                        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <path d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2.02c-3.22.7-3.9-1.37-3.9-1.37-.52-1.34-1.28-1.7-1.28-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.57-.29-5.27-1.29-5.27-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.16 1.18A10.9 10.9 0 0 1 12 6.03c.98 0 1.95.13 2.87.39 2.2-1.49 3.16-1.18 3.16-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.4-2.71 5.38-5.29 5.67.42.36.78 1.07.78 2.16v3.34c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" />
                        </svg>
                        <span>{{ available.github ? '使用 GitHub 登录' : 'GitHub 登录尚未配置' }}</span>
                    </button>
                </div>

                <p v-if="status" class="account-status">{{ status }}</p>
                <p class="account-local-note">本地游玩无需登录。</p>
            </section>
        </div>
    </Teleport>
</template>

<style scoped>
.account-root { position: relative; flex: none; }

.account-loading {
    display: block;
    width: 48px;
    height: 29px;
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
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    z-index: calc(var(--z-toolbar) + 1);
    width: 224px;
    padding: 6px;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    background: var(--bg-1);
    box-shadow: var(--shadow);
}

.account-summary {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 8px 12px;
    border-bottom: 1px solid var(--line);
    margin-bottom: 5px;
}

.account-summary span:last-child { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.account-summary strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.account-summary small { color: var(--fg-2); font-size: 10px; }

.account-menu-item {
    width: 100%;
    min-height: 34px;
    padding: 7px 9px;
    border-radius: 6px;
    text-align: left;
    font-size: 12px;
}

.account-menu-item:hover { background: var(--bg-2); }
.account-menu-item.danger { color: var(--danger); }

.account-backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--z-modal);
    display: grid;
    place-items: center;
    padding: var(--space-4);
    background: rgba(0, 0, 0, 0.76);
    backdrop-filter: blur(8px);
}

.account-panel {
    width: min(400px, 100%);
    padding: var(--space-5);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    background: var(--bg-1);
    box-shadow: var(--shadow-lg);
}

.account-panel-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-5);
}

.account-panel h2 { margin: 0 0 6px; font-size: 18px; font-weight: 600; }
.account-panel-head p { margin: 0; color: var(--fg-1); font-size: 12px; line-height: 1.5; }

.account-close {
    width: 32px;
    height: 32px;
    flex: none;
    display: grid;
    place-items: center;
    border-radius: var(--radius-sm);
    color: var(--fg-1);
}

.account-close:hover { background: var(--bg-2); color: var(--fg-0); }

.provider-list { display: flex; flex-direction: column; gap: var(--space-2); }

.provider-button {
    width: 100%;
    height: 46px;
    display: grid;
    grid-template-columns: 24px 1fr 24px;
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
.provider-button span { grid-column: 2; }
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

.account-local-note { margin: var(--space-4) 0 0; color: var(--fg-2); text-align: center; font-size: 11px; }

@media (max-width: 560px) {
    .account-name, .account-trigger > svg { display: none; }
    .account-trigger { width: 32px; padding: 3px; }
    .account-menu { position: fixed; top: 60px; right: var(--space-3); }
}
</style>
