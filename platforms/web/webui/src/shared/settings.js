// 全局设置。localStorage 单键存 JSON，三个 MPA 入口共用。
//
// 存 localStorage 而非 IndexedDB：条目极少、都是标量，且读取必须同步
// —— 播放页要在引擎起来之前就知道要不要开边玩边下。

const KEY = 'krkr2-settings';
const DOWNLOAD_HANDOFF_KEY = 'krkr2-download-handoff';
const DOWNLOAD_HANDOFF_MAX_AGE = 12 * 60 * 60 * 1000;

const DEFAULTS = {
    // 边玩边下：游戏运行时后台补齐尚未下载的字节。
    //
    // 默认关。开着能显著减少游玩中的加载等待、最终整包落到本地，但代价
    // 是会下载你可能永远不会看到的分支与结局资源，弱网下还可能与按需读
    // 抢带宽而短期内更卡。这个取舍得由玩家自己做，不能替他选。
    playWhileDownloading: false,
    // 完整下载前建议绑定自己的文件夹，避免大文件留在可能被清理的 OPFS。
    downloadFolderPrompt: true,
    // 存档后端：site 使用站点账号和 R2；webdav 由浏览器直连用户的服务。
    saveSyncProvider: 'site',
    // 回到游戏库时只提示存在本地改动，绝不自动上传。
    saveSyncReminder: true
};

function readAll() {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return { ...DEFAULTS };
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return { ...DEFAULTS };
        return { ...DEFAULTS, ...parsed };
    } catch {
        // 隐私模式下 localStorage 可能直接抛，此时用默认值继续，不能挡住启动
        return { ...DEFAULTS };
    }
}

export function getSettings() {
    return readAll();
}

export function getSetting(key) {
    return readAll()[key];
}

export function setSetting(key, value) {
    const next = readAll();
    next[key] = value;
    try {
        localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
        // 写不进去就只在本次会话生效，不报错打断用户操作
    }
    return next;
}

/** 让完整下载在画廊 Document 卸载后由同一标签页的播放页继续。 */
export function requestDownloadHandoff(gameKey) {
    if (!gameKey) return false;
    try {
        sessionStorage.setItem(DOWNLOAD_HANDOFF_KEY, JSON.stringify({
            gameKey: String(gameKey),
            createdAt: Date.now()
        }));
        return true;
    } catch {
        return false;
    }
}

export function hasDownloadHandoff(gameKey) {
    if (!gameKey) return false;
    try {
        const value = JSON.parse(sessionStorage.getItem(DOWNLOAD_HANDOFF_KEY) || 'null');
        const valid = value && value.gameKey === String(gameKey) &&
            Date.now() - Number(value.createdAt || 0) <= DOWNLOAD_HANDOFF_MAX_AGE;
        if (!valid && value) sessionStorage.removeItem(DOWNLOAD_HANDOFF_KEY);
        return !!valid;
    } catch {
        return false;
    }
}

export function clearDownloadHandoff(gameKey) {
    try {
        if (gameKey && !hasDownloadHandoff(gameKey)) return;
        sessionStorage.removeItem(DOWNLOAD_HANDOFF_KEY);
    } catch {
        // sessionStorage 在隐私模式下可能不可用，不影响正常游玩。
    }
}

export { DEFAULTS };
