<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { KeyRound, ShieldCheck, X } from '@lucide/vue';
import { api, accountLoginUrl } from './api.js';
import {
    accountCredentialsState,
    closeAccountCredentials,
    notifyAccountChanged,
    openAccountCredentials
} from './accountCredentials.js';

const view = ref('login');
const account = ref(null);
const available = ref({ steam: true, github: false });
const username = ref('');
const currentPassword = ref('');
const password = ref('');
const confirmPassword = ref('');
const errorMessage = ref('');
const submitting = ref(false);
const grantPurpose = ref('');
const firstInput = ref(null);
const dialog = ref(null);
const promptPending = ref(false);
let returnFocus = null;
let returnFocusFallback = null;

const configured = computed(() => !!account.value?.localLogin?.configured);
const linkedProviders = computed(() => {
    const linked = account.value?.user?.providers || [];
    if (!account.value?.user) {
        return ['steam', 'github'].filter((provider) => available.value[provider]);
    }
    return linked.filter((provider) => available.value[provider]);
});
const needsUsername = computed(() => view.value === 'setup' && !configured.value);
const needsCurrentPassword = computed(() => view.value === 'change' && !grantPurpose.value);

const title = computed(() => ({
    loading: '账号与登录',
    error: '账号与登录',
    login: '使用密码登录',
    recover: '找回密码登录',
    offer: '设置备用登录方式',
    setup: '设置密码登录',
    change: '修改密码',
    verify: configured.value ? '通过已绑定账号修改' : '验证已绑定账号'
}[view.value] || '账号与登录'));

function cleanReturnTo() {
    const url = new URL(location.href);
    url.searchParams.delete('localGrant');
    url.searchParams.delete('localGrantPurpose');
    url.searchParams.delete('authSuccess');
    url.searchParams.delete('authError');
    return url.pathname + url.search + url.hash;
}

function resetFields() {
    username.value = account.value?.localLogin?.username || '';
    currentPassword.value = '';
    password.value = '';
    confirmPassword.value = '';
    errorMessage.value = '';
    submitting.value = false;
}

async function loadAccount() {
    try {
        const result = await api.getAccount();
        account.value = result;
        available.value = result.availableProviders || available.value;
        return result;
    } catch (err) {
        errorMessage.value = err.message || '无法读取账号状态';
        return null;
    }
}

async function initialize(state) {
    if (!state) return;
    const stateKey = state.key;
    view.value = 'loading';
    grantPurpose.value = state.grantPurpose || '';
    promptPending.value = state.mode === 'offer';
    const result = await loadAccount();
    if (accountCredentialsState.value?.key !== stateKey) return;
    if (!result) {
        view.value = 'error';
        await focusDialog();
        return;
    }
    view.value = state.mode || 'login';
    if (view.value === 'manage') {
        view.value = configured.value ? 'change' : 'verify';
    }
    if (view.value === 'grant') {
        // reset 可以在未登录状态完成，此时 /account/me 不会泄露目标账号信息。
        // 后端会按 grant 保留已有登录名，前端只需要收集新密码。
        view.value = state.grantPurpose === 'reset' || configured.value ? 'change' : 'setup';
    }
    resetFields();
    await focusDialog();
}

watch(accountCredentialsState, (state, previous) => {
    if (state && !previous) {
        returnFocus = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        returnFocusFallback = returnFocus?.closest('.account-menu')
            ? '.account-trigger'
            : null;
    }
    if (!state && previous) {
        const target = returnFocus;
        const fallback = returnFocusFallback;
        returnFocus = null;
        returnFocusFallback = null;
        nextTick(() => {
            if (accountCredentialsState.value) return;
            const focusTarget = target?.isConnected
                ? target
                : (fallback ? document.querySelector(fallback) : null);
            if (focusTarget instanceof HTMLElement) focusTarget.focus();
        });
        return;
    }
    void initialize(state);
}, { flush: 'sync' });

async function focusDialog() {
    await nextTick();
    (firstInput.value || dialog.value)?.focus();
}

async function waitForAccountCredentialsSlot() {
    await nextTick();
    const selector = '[data-account-credentials-blocker]';
    if (!document.querySelector(selector)) return false;

    await new Promise((resolve) => {
        const observer = new MutationObserver(() => {
            if (document.querySelector(selector)) return;
            observer.disconnect();
            resolve();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        if (!document.querySelector(selector)) {
            observer.disconnect();
            resolve();
        }
    });
    return true;
}

function close() {
    if (submitting.value) return;
    if (promptPending.value) {
        void dismissOffer();
        return;
    }
    closeAccountCredentials();
}

function showLogin() {
    promptPending.value = false;
    grantPurpose.value = '';
    view.value = 'login';
    resetFields();
    nextTick(() => firstInput.value?.focus());
}

function showRecover() {
    errorMessage.value = '';
    view.value = 'recover';
    void focusDialog();
}

function showSetup() {
    grantPurpose.value = grantPurpose.value || 'setup';
    view.value = configured.value ? 'change' : 'setup';
    resetFields();
    void focusDialog();
}

function beginProvider(provider, purpose) {
    if (!available.value[provider]) return;
    location.href = accountLoginUrl(provider, {
        returnTo: cleanReturnTo(),
        purpose
    });
}

async function login() {
    if (submitting.value) return;
    errorMessage.value = '';
    submitting.value = true;
    try {
        const result = await api.loginLocalAccount(username.value, password.value);
        notifyAccountChanged(result.user || null);
        closeAccountCredentials();
    } catch (err) {
        errorMessage.value = err.message || '登录失败';
    } finally {
        submitting.value = false;
    }
}

async function dismissOffer() {
    if (submitting.value) return;
    submitting.value = true;
    errorMessage.value = '';
    try {
        const result = await api.dismissLocalLoginPrompt();
        promptPending.value = false;
        notifyAccountChanged(result.user || account.value?.user || null);
        closeAccountCredentials();
    } catch (err) {
        errorMessage.value = err.message || '暂时无法保存选择';
    } finally {
        submitting.value = false;
    }
}

async function saveCredentials() {
    if (submitting.value) return;
    errorMessage.value = '';
    if (password.value !== confirmPassword.value) {
        errorMessage.value = '两次输入的密码不一致';
        return;
    }
    submitting.value = true;
    try {
        const payload = { password: password.value };
        if (grantPurpose.value) payload.grant = true;
        if (needsUsername.value) payload.username = username.value;
        if (needsCurrentPassword.value) payload.currentPassword = currentPassword.value;
        const result = await api.saveLocalCredentials(payload);
        notifyAccountChanged(result.user || account.value?.user || null);
        closeAccountCredentials();
    } catch (err) {
        errorMessage.value = err.message || '无法保存密码登录设置';
    } finally {
        submitting.value = false;
    }
}

function onKeydown(event) {
    if (!accountCredentialsState.value) return;
    if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...(dialog.value?.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
    ) || [])].filter((element) => element.getClientRects().length > 0);
    if (!focusable.length) {
        event.preventDefault();
        dialog.value?.focus();
        return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!dialog.value?.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

async function consumeGrantResult() {
    const url = new URL(location.href);
    if (url.searchParams.get('localGrant') !== '1') return;
    const purpose = url.searchParams.get('localGrantPurpose') || 'setup';
    url.searchParams.delete('localGrant');
    url.searchParams.delete('localGrantPurpose');
    history.replaceState(null, '', url.pathname + url.search + url.hash);

    let result = await loadAccount();
    if (purpose === 'setup') {
        const waited = await waitForAccountCredentialsSlot();
        if (waited || !result) {
            const latest = await loadAccount();
            if (latest) result = latest;
        }
        if (!result?.localLogin?.shouldPrompt) return;
    }
    openAccountCredentials(purpose === 'setup' ? 'offer' : 'grant', { grantPurpose: purpose });
}

onMounted(() => {
    document.addEventListener('keydown', onKeydown);
    consumeGrantResult();
});

onUnmounted(() => document.removeEventListener('keydown', onKeydown));
</script>

<template>
    <Teleport to="body">
        <Transition name="fade">
            <div
                v-if="accountCredentialsState"
                class="credentials-backdrop"
                @click.self="close">
                <section
                    ref="dialog"
                    class="credentials-dialog"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="credentials-title"
                    :aria-busy="view === 'loading'"
                    tabindex="-1">
                    <header class="credentials-head">
                        <span class="credentials-icon" aria-hidden="true">
                            <ShieldCheck v-if="view === 'offer'" :size="18" />
                            <KeyRound v-else :size="18" />
                        </span>
                        <h2 id="credentials-title">{{ title }}</h2>
                        <button
                            class="btn btn-ghost btn-sm credentials-close"
                            type="button"
                            aria-label="关闭"
                            :disabled="submitting"
                            @click="close">
                            <X :size="16" />
                        </button>
                    </header>

                    <div v-if="view === 'loading'" class="credentials-loading" role="status">
                        <span class="spinner" aria-hidden="true" />
                        <span>正在读取账号状态</span>
                    </div>

                    <template v-else-if="view === 'error'">
                        <p class="credentials-error" aria-live="polite">{{ errorMessage }}</p>
                        <div class="credentials-actions">
                            <button class="btn btn-ghost" type="button" @click="close">关闭</button>
                        </div>
                    </template>

                    <template v-else-if="view === 'offer'">
                        <p class="credentials-copy">
                            设置本站登录名和密码后，下次无需跳转到 Steam 或 GitHub。
                            忘记密码时仍可通过已绑定的平台重置。
                        </p>
                        <p v-if="errorMessage" class="credentials-error" aria-live="polite">{{ errorMessage }}</p>
                        <div class="credentials-actions">
                            <button class="btn btn-ghost" type="button" :disabled="submitting" @click="dismissOffer">
                                暂不设置
                            </button>
                            <button class="btn btn-primary" type="button" :disabled="submitting" @click="showSetup">
                                设置密码登录
                            </button>
                        </div>
                    </template>

                    <form v-else-if="view === 'login'" class="credentials-form" @submit.prevent="login">
                        <label class="field">
                            <span>本站登录名</span>
                            <input ref="firstInput" v-model.trim="username" class="input"
                                autocomplete="username" required>
                        </label>
                        <label class="field">
                            <span>密码</span>
                            <input v-model="password" class="input" type="password"
                                autocomplete="current-password" maxlength="128" required>
                        </label>
                        <p v-if="errorMessage" class="credentials-error" aria-live="polite">{{ errorMessage }}</p>
                        <div class="credentials-link-row">
                            <button class="credentials-link" type="button" @click="showRecover">忘记密码</button>
                        </div>
                        <div class="credentials-actions">
                            <button class="btn btn-ghost" type="button" :disabled="submitting" @click="close">
                                {{ promptPending ? '暂不设置' : '取消' }}
                            </button>
                            <button class="btn btn-primary" type="submit" :disabled="submitting || !username || !password">
                                {{ submitting ? '正在登录' : '登录' }}
                            </button>
                        </div>
                    </form>

                    <template v-else-if="view === 'recover' || view === 'verify'">
                        <p class="credentials-copy">
                            {{ view === 'recover'
                                ? '选择已绑定的平台验证身份，然后设置新密码。'
                                : '首次设置密码登录需要重新验证一个已绑定的平台。' }}
                        </p>
                        <div class="credentials-provider-list">
                            <button
                                v-for="provider in linkedProviders"
                                :key="provider"
                                class="btn credentials-provider"
                                type="button"
                                @click="beginProvider(provider, view === 'recover' ? 'reset' : 'reauth')">
                                使用 {{ provider === 'steam' ? 'Steam' : 'GitHub' }} 验证
                            </button>
                        </div>
                        <p v-if="!linkedProviders.length" class="credentials-error">没有可用的已绑定平台。</p>
                        <p v-if="errorMessage" class="credentials-error" aria-live="polite">{{ errorMessage }}</p>
                        <div class="credentials-actions">
                            <button v-if="view === 'recover'" class="btn btn-ghost" type="button" @click="showLogin">返回密码登录</button>
                            <button v-else class="btn btn-ghost" type="button" @click="close">取消</button>
                        </div>
                    </template>

                    <form v-else class="credentials-form" @submit.prevent="saveCredentials">
                        <label v-if="needsUsername" class="field">
                            <span>本站登录名</span>
                            <input
                                ref="firstInput"
                                v-model.trim="username"
                                class="input"
                                autocomplete="username"
                                required>
                            <small class="hint">3 至 32 个字符，以字母或数字开头，可使用字母、数字、_、.、-。</small>
                        </label>
                        <div v-else-if="account?.localLogin?.username" class="credentials-username">
                            <span>本站登录名</span>
                            <strong>{{ account.localLogin.username }}</strong>
                        </div>
                        <label v-if="needsCurrentPassword" class="field">
                            <span>当前密码</span>
                            <input
                                ref="firstInput"
                                v-model="currentPassword"
                                class="input"
                                type="password"
                                autocomplete="current-password"
                                required>
                        </label>
                        <label class="field">
                            <span>{{ view === 'change' ? '新密码' : '密码' }}</span>
                            <input
                                :ref="needsUsername || needsCurrentPassword ? null : 'firstInput'"
                                v-model="password"
                                class="input"
                                type="password"
                                autocomplete="new-password"
                                minlength="10"
                                maxlength="128"
                                required>
                        </label>
                        <label class="field">
                            <span>确认{{ view === 'change' ? '新' : '' }}密码</span>
                            <input
                                v-model="confirmPassword"
                                class="input"
                                type="password"
                                autocomplete="new-password"
                                minlength="10"
                                maxlength="128"
                                required>
                        </label>
                        <p v-if="errorMessage" class="credentials-error" aria-live="polite">{{ errorMessage }}</p>
                        <div v-if="view === 'change' && !grantPurpose" class="credentials-alternate">
                            <span>无法使用当前密码？</span>
                            <button
                                v-for="provider in linkedProviders"
                                :key="provider"
                                class="credentials-link"
                                type="button"
                                @click="beginProvider(provider, 'reauth')">
                                通过 {{ provider === 'steam' ? 'Steam' : 'GitHub' }} 验证
                            </button>
                        </div>
                        <div class="credentials-actions">
                            <button class="btn btn-ghost" type="button" :disabled="submitting" @click="close">取消</button>
                            <button
                                class="btn btn-primary"
                                type="submit"
                                :disabled="submitting || (needsUsername && !username) ||
                                    (needsCurrentPassword && !currentPassword) || !password || !confirmPassword">
                                {{ submitting ? '正在保存' : '保存' }}
                            </button>
                        </div>
                    </form>
                </section>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
.credentials-backdrop {
    position: fixed;
    inset: 0;
    z-index: calc(var(--z-modal) + 20);
    display: grid;
    place-items: center;
    padding: var(--space-4);
    background: rgba(0, 0, 0, .72);
    backdrop-filter: blur(6px);
}

.credentials-dialog {
    width: min(440px, 100%);
    max-height: calc(100dvh - 32px);
    overflow-y: auto;
    padding: var(--space-5);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    background: var(--bg-1);
    box-shadow: var(--shadow-lg);
}

.credentials-head { display: flex; align-items: center; gap: 10px; margin-bottom: var(--space-4); }
.credentials-head h2 { min-width: 0; margin: 0; font-size: 16px; font-weight: 600; }
.credentials-icon { display: grid; place-items: center; color: var(--fg-1); }
.credentials-close { width: 30px; height: 30px; justify-content: center; margin-left: auto; padding: 0; }
.credentials-copy { margin: 0; color: var(--fg-1); font-size: 13px; line-height: 1.7; }
.credentials-loading { min-height: 120px; display: flex; align-items: center; justify-content: center; gap: 10px; color: var(--fg-2); font-size: 12px; }
.credentials-form { display: flex; flex-direction: column; gap: var(--space-4); }
.credentials-form .field > span { color: var(--fg-1); font-size: 12px; font-weight: 500; }
.credentials-error { margin: 0; color: var(--danger); font-size: 12px; line-height: 1.5; }
.credentials-actions { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-5); }
.credentials-link-row { display: flex; justify-content: flex-end; margin-top: calc(var(--space-2) * -1); }
.credentials-link { color: var(--fg-1); font-size: 12px; text-decoration: underline; text-underline-offset: 3px; }
.credentials-link:hover { color: var(--fg-0); }
.credentials-provider-list { display: grid; gap: var(--space-2); margin-top: var(--space-4); }
.credentials-provider { justify-content: center; width: 100%; }
.credentials-username { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--bg-2); }
.credentials-username span { color: var(--fg-2); font-size: 12px; }
.credentials-username strong { min-width: 0; overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.credentials-alternate { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding-top: var(--space-3); border-top: 1px solid var(--line); color: var(--fg-2); font-size: 11px; }

.fade-enter-active, .fade-leave-active { transition: opacity var(--dur) var(--ease); }
.fade-enter-from, .fade-leave-to { opacity: 0; }

@media (max-width: 640px) {
    .credentials-backdrop { align-items: end; padding: 0; }
    .credentials-dialog { width: 100%; max-height: min(88dvh, 680px); padding: var(--space-5) var(--space-4) max(var(--space-5), env(safe-area-inset-bottom)); border-right: 0; border-bottom: 0; border-left: 0; border-radius: var(--radius) var(--radius) 0 0; }
    .credentials-actions { display: grid; grid-template-columns: 1fr 1fr; }
    .credentials-actions .btn:only-child { grid-column: 1 / -1; }
    .credentials-actions .btn { justify-content: center; min-width: 0; white-space: normal; text-align: center; }
}
</style>
