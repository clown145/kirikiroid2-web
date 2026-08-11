// 全局设置。localStorage 单键存 JSON，三个 MPA 入口共用。
//
// 存 localStorage 而非 IndexedDB：条目极少、都是标量，且读取必须同步
// —— 播放页要在引擎起来之前就知道要不要开边玩边下。

const KEY = 'krkr2-settings';

const DEFAULTS = {
    // 边玩边下：游戏运行时后台补齐尚未下载的字节。
    //
    // 默认关。开着能显著减少游玩中的加载等待、最终整包落到本地，但代价
    // 是会下载你可能永远不会看到的分支与结局资源，弱网下还可能与按需读
    // 抢带宽而短期内更卡。这个取舍得由玩家自己做，不能替他选。
    playWhileDownloading: false
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

export { DEFAULTS };
