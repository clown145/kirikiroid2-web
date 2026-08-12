import { readonly, ref } from 'vue';

const needsPermission = ref(false);
const folderName = ref('');
const visible = ref(false);
const blocking = ref(false);
const restoring = ref(false);
const error = ref('');
const version = ref(0);

let ignored = false;
let checkPromise = null;
let waiters = [];

function folderApi() {
    return window.KrKr2Folder || null;
}

function settleWaiters(result) {
    const current = waiters;
    waiters = [];
    for (const resolve of current) resolve(result);
}

async function check({ prompt = true, block = false } = {}) {
    if (checkPromise) {
        await checkPromise;
        if (block && needsPermission.value) {
            blocking.value = true;
            visible.value = true;
        }
        return !needsPermission.value;
    }

    checkPromise = (async () => {
        const api = folderApi();
        if (!api?.supported?.()) {
            needsPermission.value = false;
            folderName.value = '';
            return;
        }

        const bound = await api.hasBinding();
        const handle = bound ? await api.tryRestore() : null;
        needsPermission.value = !!bound && !handle;
        folderName.value = handle?.name || (bound ? await api.name() : '');

        if (!needsPermission.value) {
            ignored = false;
            visible.value = false;
            blocking.value = false;
            error.value = '';
            return;
        }
        if (block) blocking.value = true;
        if (prompt && (!ignored || block)) visible.value = true;
    })().catch(() => {
        // IndexedDB 或权限查询异常不能阻挡未确认绑定的用户浏览网站。
    }).finally(() => {
        checkPromise = null;
    });

    await checkPromise;
    return !needsPermission.value;
}

async function requireAccess() {
    if (await check({ prompt: true, block: true })) return 'granted';
    return await new Promise((resolve) => waiters.push(resolve));
}

async function restore() {
    if (restoring.value) return;
    restoring.value = true;
    error.value = '';
    try {
        const name = window.KrKr2Cache?.bindFolder
            ? await window.KrKr2Cache.bindFolder()
            : (await folderApi()?.request())?.name;
        if (!name) throw new Error('没有获得文件夹访问权限');
        needsPermission.value = false;
        folderName.value = name;
        visible.value = false;
        blocking.value = false;
        ignored = false;
        version.value++;
        settleWaiters('granted');
    } catch (err) {
        if (err?.name !== 'AbortError') error.value = err?.message || '无法恢复文件夹访问';
    } finally {
        restoring.value = false;
    }
}

async function unbind() {
    if (restoring.value) return;
    restoring.value = true;
    error.value = '';
    try {
        if (window.KrKr2Cache?.unbindFolder) await window.KrKr2Cache.unbindFolder();
        else await folderApi()?.unbind();
        needsPermission.value = false;
        folderName.value = '';
        visible.value = false;
        blocking.value = false;
        ignored = false;
        version.value++;
        settleWaiters('unbound');
    } catch (err) {
        error.value = err?.message || '无法解除文件夹绑定';
    } finally {
        restoring.value = false;
    }
}

function ignore() {
    if (blocking.value) return;
    ignored = true;
    visible.value = false;
    error.value = '';
}

function prompt({ block = false } = {}) {
    if (!needsPermission.value || (ignored && !block)) return;
    if (block) blocking.value = true;
    visible.value = true;
}

export function useFolderAccess() {
    return {
        needsPermission: readonly(needsPermission),
        folderName: readonly(folderName),
        visible: readonly(visible),
        blocking: readonly(blocking),
        restoring: readonly(restoring),
        error: readonly(error),
        version: readonly(version),
        check,
        requireAccess,
        restore,
        unbind,
        ignore,
        prompt
    };
}
