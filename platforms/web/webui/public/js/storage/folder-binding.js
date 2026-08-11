/*
 * 本地文件夹绑定 —— 把「完整下载」的落点放到用户自己的磁盘上。
 *
 * 为什么需要它：OPFS 是 best-effort 存储，浏览器在存储压力下会清掉它，
 * navigator.storage.persist() 在 Chromium 下只是启发式授予、不保证；用户
 * 清一次浏览数据也照样没。几个 GB 的游戏包放在那里并不安全。
 *
 * 绑定之后数据就是磁盘上的普通文件，浏览器永远不会自动删，用户能直接
 * 看到、拷走、备份。每个游戏按标题建立目录，JSON 资源恢复清单中的相对
 * 路径；ZIP/XP3 下载完成后就是原始文件。
 *
 * 句柄存 IndexedDB（结构化克隆能存 FileSystemDirectoryHandle），下次进站
 * 用 queryPermission/requestPermission 恢复。Chromium 会记住用户的授权，
 * 但恢复动作必须发生在用户手势里，所以对外只暴露 tryRestore（静默，只在
 * 已授权时成功）和 request（需手势）两个入口。
 */
(function () {
    'use strict';

    var DB_NAME = 'krkr2-folder';
    var STORE = 'handles';
    var KEY = 'cache-root';

    function idbOpen() {
        return new Promise(function (resolve, reject) {
            var req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = function (e) {
                e.target.result.createObjectStore(STORE);
            };
            req.onsuccess = function (e) { resolve(e.target.result); };
            req.onerror = function () { reject(req.error); };
        });
    }

    async function idbGet() {
        try {
            var db = await idbOpen();
            return await new Promise(function (resolve) {
                var req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
                req.onsuccess = function () { resolve(req.result || null); };
                req.onerror = function () { resolve(null); };
            });
        } catch (e) {
            return null;
        }
    }

    async function idbPut(handle) {
        try {
            var db = await idbOpen();
            await new Promise(function (resolve, reject) {
                var tx = db.transaction(STORE, 'readwrite');
                tx.objectStore(STORE).put(handle, KEY);
                tx.oncomplete = resolve;
                tx.onerror = function () { reject(tx.error); };
            });
            return true;
        } catch (e) {
            console.warn('[folder] 句柄保存失败：', e);
            return false;
        }
    }

    async function idbDelete() {
        try {
            var db = await idbOpen();
            await new Promise(function (resolve) {
                var tx = db.transaction(STORE, 'readwrite');
                tx.objectStore(STORE).delete(KEY);
                tx.oncomplete = resolve;
                tx.onerror = resolve;
            });
        } catch (e) {}
    }

    function supported() {
        return typeof window.showDirectoryPicker === 'function';
    }

    async function permission(handle, request) {
        if (!handle) return 'denied';
        var opts = { mode: 'readwrite' };
        try {
            var state = await handle.queryPermission(opts);
            if (state === 'granted') return 'granted';
            if (!request) return state;          // 'prompt' —— 需要用户手势
            return await handle.requestPermission(opts);
        } catch (e) {
            return 'denied';
        }
    }

    var bound = null;      // 已确认可写的目录句柄

    /**
     * 静默恢复上次绑定的目录。只在权限仍是 granted 时成功 —— 不弹窗，
     * 可以在页面加载时直接调用。
     */
    async function tryRestore() {
        if (bound) return bound;
        if (!supported()) return null;
        var handle = await idbGet();
        if (!handle) return null;
        if (await permission(handle, false) !== 'granted') return null;
        bound = handle;
        return handle;
    }

    /**
     * 请求绑定一个目录。必须在用户手势里调用（会弹目录选择器）。
     * 已有句柄但权限过期时先尝试续权，避免让用户重新找一遍文件夹。
     */
    async function request() {
        if (!supported()) throw new Error('当前浏览器不支持选择文件夹');

        var existing = await idbGet();
        if (existing && await permission(existing, true) === 'granted') {
            bound = existing;
            return existing;
        }

        var handle = await window.showDirectoryPicker({
            mode: 'readwrite',
            id: 'krkr2-games',            // 让浏览器记住上次的位置
            startIn: 'downloads'
        });
        if (await permission(handle, true) !== 'granted') {
            throw new Error('没有获得该文件夹的写入权限');
        }
        await idbPut(handle);
        bound = handle;
        return handle;
    }

    async function unbind() {
        bound = null;
        await idbDelete();
    }

    /** 是否绑过（不代表当前有权限）。用于决定要不要提示"点一下恢复"。 */
    async function hasBinding() {
        return !!(await idbGet());
    }

    function current() { return bound; }

    async function name() {
        var h = bound || await idbGet();
        return h ? h.name : '';
    }

    window.KrKr2Folder = {
        supported: supported,
        tryRestore: tryRestore,
        request: request,
        unbind: unbind,
        hasBinding: hasBinding,
        current: current,
        name: name
    };
})();
