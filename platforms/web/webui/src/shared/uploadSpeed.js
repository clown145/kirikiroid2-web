const DEFAULT_WINDOW_MS = 5000;
const DEFAULT_IDLE_MS = 5000;

function nowMs() {
    return performance.now();
}

export class UploadSpeedTracker {
    constructor({ windowMs = DEFAULT_WINDOW_MS, idleMs = DEFAULT_IDLE_MS } = {}) {
        this.windowMs = windowMs;
        this.idleMs = idleMs;
        this.samples = [];
    }

    reset() {
        this.samples = [];
    }

    record(bytes, now = nowMs()) {
        const value = Number(bytes);
        if (!Number.isFinite(value) || value < 0 || !Number.isFinite(now)) return this.getSpeed(now);

        const latest = this.samples[this.samples.length - 1];
        if (latest) {
            if (value < latest.bytes || now < latest.time || now - latest.time >= this.idleMs) {
                this.reset();
            } else if (value === latest.bytes) {
                return this.getSpeed(now);
            }
        }

        this.samples.push({ time: now, bytes: value });

        const cutoff = now - this.windowMs;
        while (this.samples.length > 2 && this.samples[1].time < cutoff) {
            this.samples.shift();
        }

        return this.getSpeed(now);
    }

    getSpeed(now = nowMs()) {
        if (!Number.isFinite(now) || this.samples.length < 2) return 0;

        const first = this.samples[0];
        const latest = this.samples[this.samples.length - 1];
        if (now - latest.time >= this.idleMs) return 0;

        const elapsedSeconds = (latest.time - first.time) / 1000;
        const transferredBytes = latest.bytes - first.bytes;
        if (elapsedSeconds <= 0 || transferredBytes <= 0) return 0;

        return transferredBytes / elapsedSeconds;
    }
}
