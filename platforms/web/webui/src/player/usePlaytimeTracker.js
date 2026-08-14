// 游玩时长前台采集与心跳上报。
//
// 1. 引擎处于 running 状态且标签页处于活跃（非隐藏）时累计时长；
// 2. 每 60 秒上报一次心跳增量；
// 3. 页面切入后台、跳转或关闭时通过 keepalive fetch 冲刷上报未结余秒数；
// 4. 同步写入 localStorage 作为离线/游客兜底。

import { ref, onMounted, onUnmounted, watch } from 'vue';
import { api } from '../shared/api.js';
import { getSetting } from '../shared/settings.js';

const REPORT_INTERVAL_SECONDS = 60;
const MIN_FLUSH_SECONDS = 3;

export function usePlaytimeTracker(gameIdRef, phaseRef) {
    const sessionSeconds = ref(0);
    const totalSeconds = ref(0);
    let pendingSeconds = 0;
    let ticker = null;
    let isTracking = false;

    function getLocalPlaytime(id) {
        if (!id) return 0;
        try {
            return parseInt(localStorage.getItem(`krkr2_playtime_${id}`) || '0', 10) || 0;
        } catch {
            return 0;
        }
    }

    function setLocalPlaytime(id, sec) {
        if (!id) return;
        try {
            localStorage.setItem(`krkr2_playtime_${id}`, String(sec));
        } catch {}
    }

    async function reportDelta(delta) {
        const id = gameIdRef.value;
        if (!id || id === 'local' || delta <= 0) return;
        if (!getSetting('uploadPlaytime')) return;

        try {
            const res = await api.sendPlaytimeHeartbeat(id, delta);
            if (res?.totalSeconds) {
                totalSeconds.value = res.totalSeconds;
                setLocalPlaytime(id, res.totalSeconds);
            }
        } catch (err) {
            console.debug('[playtime] heartbeat failed, kept in local:', err);
        }
    }

    function flushBeacon() {
        const id = gameIdRef.value;
        const delta = pendingSeconds;
        if (!id || id === 'local' || delta < MIN_FLUSH_SECONDS) return;
        if (!getSetting('uploadPlaytime')) {
            pendingSeconds = 0;
            return;
        }

        pendingSeconds = 0;
        try {
            // 使用 keepalive 保证页面被卸载时请求仍能送达 Worker
            fetch('/api/playtime/heartbeat', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ gameId: id, deltaSeconds: delta }),
                keepalive: true
            }).catch(() => {});
        } catch {}
    }

    function tick() {
        if (document.hidden) return; // 切换标签页或锁屏时不累计

        sessionSeconds.value++;
        pendingSeconds++;

        const id = gameIdRef.value;
        if (id) {
            const currentTotal = getLocalPlaytime(id) + 1;
            setLocalPlaytime(id, currentTotal);
            totalSeconds.value = currentTotal;
        }

        if (pendingSeconds >= REPORT_INTERVAL_SECONDS) {
            const delta = pendingSeconds;
            pendingSeconds = 0;
            reportDelta(delta);
        }
    }

    function start() {
        if (isTracking) return;
        isTracking = true;
        const id = gameIdRef.value;
        if (id) {
            totalSeconds.value = getLocalPlaytime(id);
        }
        ticker = setInterval(tick, 1000);
    }

    function stop() {
        if (!isTracking) return;
        isTracking = false;
        if (ticker) {
            clearInterval(ticker);
            ticker = null;
        }
        if (pendingSeconds > 0) {
            const delta = pendingSeconds;
            pendingSeconds = 0;
            reportDelta(delta);
        }
    }

    function onVisibilityChange() {
        if (document.visibilityState === 'hidden' && pendingSeconds >= MIN_FLUSH_SECONDS) {
            flushBeacon();
        }
    }

    function onPageHide() {
        if (pendingSeconds >= MIN_FLUSH_SECONDS) {
            flushBeacon();
        }
    }

    onMounted(() => {
        document.addEventListener('visibilitychange', onVisibilityChange);
        window.addEventListener('pagehide', onPageHide);
        window.addEventListener('beforeunload', onPageHide);

        watch(
            [phaseRef, gameIdRef],
            ([phase, id]) => {
                if (phase === 'running' && id && id !== 'local') {
                    start();
                } else if (phase !== 'running') {
                    stop();
                }
            },
            { immediate: true }
        );
    });

    onUnmounted(() => {
        document.removeEventListener('visibilitychange', onVisibilityChange);
        window.removeEventListener('pagehide', onPageHide);
        window.removeEventListener('beforeunload', onPageHide);
        stop();
    });

    return {
        sessionSeconds,
        totalSeconds
    };
}
