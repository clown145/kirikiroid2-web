export class FileHasher {
    constructor({ workerFactory } = {}) {
        this.worker = (workerFactory || (() => new Worker(
            new URL('./sha256.worker.js', import.meta.url),
            { type: 'module', name: 'krkr2-sha256' }
        )))();
        this.jobs = new Map();
        this.nextId = 1;
        this.worker.addEventListener('message', (event) => this.handleMessage(event.data));
        this.worker.addEventListener('error', (event) => this.handleWorkerError(event));
    }

    hash(file, { onProgress, signal } = {}) {
        if (signal?.aborted) return Promise.reject(signal.reason || new DOMException('Aborted', 'AbortError'));
        const id = String(this.nextId++);

        return new Promise((resolve, reject) => {
            const abort = () => {
                this.worker.postMessage({ type: 'cancel', id });
                this.finishJob(id, () => reject(signal.reason || new DOMException('Aborted', 'AbortError')));
            };
            this.jobs.set(id, { resolve, reject, onProgress, signal, abort });
            signal?.addEventListener('abort', abort, { once: true });
            this.worker.postMessage({ type: 'hash', id, file });
        });
    }

    handleMessage(message) {
        const job = this.jobs.get(message?.id);
        if (!job) return;

        if (message.type === 'progress') {
            job.onProgress?.(message.loaded, message.total);
            return;
        }
        if (message.type === 'done') {
            this.finishJob(message.id, () => job.resolve(message.sha256));
            return;
        }
        if (message.type === 'error') {
            const err = message.name === 'AbortError'
                ? new DOMException(message.message, 'AbortError')
                : new Error(message.message);
            this.finishJob(message.id, () => job.reject(err));
        }
    }

    handleWorkerError(event) {
        const err = new Error(event?.message || 'SHA-256 Worker 异常退出');
        for (const id of [...this.jobs.keys()]) {
            const job = this.jobs.get(id);
            this.finishJob(id, () => job.reject(err));
        }
    }

    finishJob(id, callback) {
        const job = this.jobs.get(id);
        if (!job) return;
        job.signal?.removeEventListener('abort', job.abort);
        this.jobs.delete(id);
        callback();
    }

    destroy() {
        const err = new DOMException('Hasher destroyed', 'AbortError');
        for (const id of [...this.jobs.keys()]) {
            const job = this.jobs.get(id);
            this.finishJob(id, () => job.reject(err));
        }
        this.worker.terminate();
    }
}
