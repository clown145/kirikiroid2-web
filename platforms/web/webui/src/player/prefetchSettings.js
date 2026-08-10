const STORAGE_KEY = 'krkr2-prefetch-settings-v1';

const DEFAULTS = Object.freeze({
    enabled: true,
    trace: false
});

export function loadPrefetchSettings() {
    try {
        const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        return {
            enabled: value?.enabled !== false,
            trace: value?.trace === true
        };
    } catch {
        return { ...DEFAULTS };
    }
}

export function savePrefetchSettings(value) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
        enabled: value.enabled !== false,
        trace: value.trace === true
    }));
}
