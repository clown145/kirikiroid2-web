export const DEFAULT_UPLOAD_CONCURRENCY = 5;
export const DEFAULT_STALL_TIMEOUT_MS = 30000;
export const DEFAULT_MAX_ATTEMPTS = 5;

const RETRYABLE_STATUSES = new Set([408, 425, 429]);

export class UploadPausedError extends Error {
    constructor() {
        super('上传已暂停');
        this.name = 'UploadPausedError';
    }
}

export class UploadCancelledError extends Error {
    constructor() {
        super('上传已停止');
        this.name = 'UploadCancelledError';
    }
}

export class UploadActionExpiredError extends Error {
    constructor(message = '上传凭证已过期') {
        super(message);
        this.name = 'UploadActionExpiredError';
        this.retryable = false;
        this.expired = true;
    }
}

export class UploadRequestError extends Error {
    constructor(message, { status = 0, retryable = false } = {}) {
        super(message);
        this.name = 'UploadRequestError';
        this.status = status;
        this.retryable = retryable;
    }
}

export class UploadControl {
    constructor() {
        this.state = 'running';
        this.aborters = new Set();
        this.waiters = new Set();
    }

    get paused() {
        return this.state === 'paused';
    }

    get cancelled() {
        return this.state === 'cancelled';
    }

    pause() {
        if (this.state !== 'running') return;
        this.state = 'paused';
        this.abortActive();
    }

    resume() {
        if (this.state !== 'paused') return;
        this.state = 'running';
        for (const waiter of this.waiters) waiter.resolve();
        this.waiters.clear();
    }

    cancel() {
        if (this.state === 'cancelled') return;
        this.state = 'cancelled';
        this.abortActive();
        const err = new UploadCancelledError();
        for (const waiter of this.waiters) waiter.reject(err);
        this.waiters.clear();
    }

    abortActive() {
        for (const abort of [...this.aborters]) abort();
    }

    registerAborter(abort) {
        if (this.cancelled || this.paused) {
            abort();
            return () => {};
        }
        this.aborters.add(abort);
        return () => this.aborters.delete(abort);
    }

    waitUntilRunning() {
        if (this.cancelled) return Promise.reject(new UploadCancelledError());
        if (!this.paused) return Promise.resolve();
        return new Promise((resolve, reject) => this.waiters.add({ resolve, reject }));
    }

    async delay(ms) {
        await this.waitUntilRunning();
        await new Promise((resolve, reject) => {
            let unregister = () => {};
            let settled = false;
            const finish = (callback) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                unregister();
                callback();
            };
            const timer = setTimeout(() => finish(resolve), Math.max(0, ms));
            unregister = this.registerAborter(() => finish(() => {
                if (this.cancelled) reject(new UploadCancelledError());
                else resolve();
            }));
        });
        await this.waitUntilRunning();
    }
}

export class UploadTaskPool {
    constructor(limit = DEFAULT_UPLOAD_CONCURRENCY) {
        if (!Number.isInteger(limit) || limit < 1) throw new Error('并发数必须是正整数');
        this.limit = limit;
        this.active = 0;
        this.queue = [];
    }

    run(task, { priority = false } = {}) {
        return new Promise((resolve, reject) => {
            const entry = { task, resolve, reject };
            if (priority) this.queue.unshift(entry);
            else this.queue.push(entry);
            this.drain();
        });
    }

    drain() {
        while (this.active < this.limit && this.queue.length) {
            const entry = this.queue.shift();
            this.active++;
            Promise.resolve()
                .then(entry.task)
                .then(entry.resolve, entry.reject)
                .finally(() => {
                    this.active--;
                    this.drain();
                });
        }
    }
}

export class ProgressLedger {
    constructor(onChange = () => {}) {
        this.values = new Map();
        this.total = 0;
        this.onChange = onChange;
    }

    set(key, loaded, maximum = Number.MAX_SAFE_INTEGER) {
        const value = Math.max(0, Math.min(Number(loaded) || 0, maximum));
        const previous = this.values.get(key) || 0;
        this.values.set(key, value);
        this.total += value - previous;
        this.onChange(this.total, value - previous, key);
        return this.total;
    }

    delete(key) {
        if (!this.values.has(key)) return this.total;
        const previous = this.values.get(key);
        this.values.delete(key);
        this.total -= previous;
        this.onChange(this.total, -previous, key);
        return this.total;
    }
}

export function isRetryableStatus(status) {
    return RETRYABLE_STATUSES.has(status) || status >= 500;
}

export function isUploadActionExpired(upload, now = Date.now(), skewMs = 60000) {
    return !!upload?.expiresAt && upload.expiresAt <= now + skewMs;
}

function backoffDelay(failureCount, random = Math.random) {
    const base = Math.min(1000 * (2 ** Math.max(0, failureCount - 1)), 10000);
    return Math.round(base * (0.8 + random() * 0.4));
}

export async function withUploadRetry(operation, {
    control = new UploadControl(),
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    sleepFn = null,
    random = Math.random,
    onRetry
} = {}) {
    let failures = 0;
    for (;;) {
        await control.waitUntilRunning();
        try {
            return await operation(failures + 1);
        } catch (err) {
            if (control.cancelled || err instanceof UploadCancelledError) throw new UploadCancelledError();
            if (control.paused || err instanceof UploadPausedError) {
                await control.waitUntilRunning();
                continue;
            }
            if (!err?.retryable || failures >= maxAttempts - 1) throw err;
            failures++;
            const delay = backoffDelay(failures, random);
            onRetry?.({ attempt: failures + 1, delay, error: err });
            if (sleepFn) {
                await sleepFn(delay);
                await control.waitUntilRunning();
            } else {
                await control.delay(delay);
            }
        }
    }
}

function xhrErrorForStatus(status, responseText) {
    if (status === 401 || status === 403) {
        return new UploadActionExpiredError(`上传凭证被拒绝 (${status})`);
    }
    return new UploadRequestError(
        `对象存储上传失败 (${status}): ${responseText || 'Unknown error'}`,
        { status, retryable: isRetryableStatus(status) }
    );
}

export function putBlobOnce(url, blob, {
    control = new UploadControl(),
    headers = {},
    stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
    xhrFactory = () => new XMLHttpRequest(),
    onProgress,
    onWireBytes
} = {}) {
    return new Promise((resolve, reject) => {
        const xhr = xhrFactory();
        let settled = false;
        let stalled = false;
        let lastWireLoaded = 0;
        let stallTimer = null;
        let unregister = () => {};

        const finish = (callback) => {
            if (settled) return;
            settled = true;
            if (stallTimer) clearTimeout(stallTimer);
            unregister();
            callback();
        };
        const armStallTimer = () => {
            if (stallTimer) clearTimeout(stallTimer);
            stallTimer = setTimeout(() => {
                stalled = true;
                xhr.abort();
            }, stallTimeoutMs);
        };
        const report = (loaded) => {
            const normalized = Math.max(0, Math.min(Number(loaded) || 0, blob.size));
            const wireDelta = Math.max(0, normalized - lastWireLoaded);
            lastWireLoaded = normalized;
            if (wireDelta) onWireBytes?.(wireDelta);
            onProgress?.(normalized, blob.size);
            armStallTimer();
        };

        xhr.open('PUT', url);
        for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
        xhr.upload.onprogress = (event) => report(event.loaded);
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                report(blob.size);
                finish(() => resolve({ etag: xhr.getResponseHeader('ETag') || '' }));
            } else {
                finish(() => reject(xhrErrorForStatus(xhr.status, xhr.responseText || xhr.statusText)));
            }
        };
        xhr.onerror = () => finish(() => reject(new UploadRequestError('网络中断，上传失败', { retryable: true })));
        xhr.onabort = () => finish(() => {
            if (control.cancelled) reject(new UploadCancelledError());
            else if (control.paused) reject(new UploadPausedError());
            else if (stalled) reject(new UploadRequestError('上传 30 秒无进度，已自动重试', { retryable: true }));
            else reject(new UploadRequestError('上传请求被中止', { retryable: true }));
        });

        unregister = control.registerAborter(() => xhr.abort());
        if (control.cancelled) {
            finish(() => reject(new UploadCancelledError()));
        } else if (control.paused) {
            finish(() => reject(new UploadPausedError()));
        } else if (!settled) {
            armStallTimer();
            xhr.send(blob);
        }
    });
}

export function uploadBlob(url, blob, options = {}) {
    const { onProgress, ...retryOptions } = options;
    return withUploadRetry(
        () => {
            onProgress?.(0, blob.size);
            return putBlobOnce(url, blob, { ...options, onProgress });
        },
        retryOptions
    );
}

function responseError(response, text, expiredStatuses) {
    const refreshStatuses = expiredStatuses === true ? [401, 403] : (expiredStatuses || []);
    if (refreshStatuses.includes(response.status)) {
        return new UploadActionExpiredError(`上传凭证已过期 (${response.status})`);
    }
    return new UploadRequestError(
        `请求失败 (${response.status}): ${String(text || '').slice(0, 1000)}`,
        { status: response.status, retryable: isRetryableStatus(response.status) }
    );
}

export function fetchWithUploadRetry(url, init = {}, {
    control = new UploadControl(),
    fetchFn = fetch,
    expiredStatuses = false,
    requestTimeoutMs = 0,
    ...retryOptions
} = {}) {
    return withUploadRetry(async () => {
        const controller = new AbortController();
        let timedOut = false;
        const timeoutMs = Number(requestTimeoutMs);
        const timeoutId = Number.isFinite(timeoutMs) && timeoutMs > 0
            ? setTimeout(() => {
                timedOut = true;
                controller.abort();
            }, timeoutMs)
            : null;
        const unregister = control.registerAborter(() => controller.abort());
        try {
            const response = await fetchFn(url, { ...init, signal: controller.signal });
            if (!response.ok) throw responseError(response, await response.text(), expiredStatuses);
            return response;
        } catch (err) {
            if (control.cancelled) throw new UploadCancelledError();
            if (control.paused) throw new UploadPausedError();
            if (err?.name === 'AbortError') {
                const message = timedOut
                    ? `请求 ${Math.ceil(timeoutMs / 1000)} 秒无响应，已自动重试`
                    : '网络请求被中止';
                throw new UploadRequestError(message, { retryable: true });
            }
            if (err instanceof TypeError) {
                throw new UploadRequestError(`网络请求失败: ${err.message}`, { retryable: true });
            }
            throw err;
        } finally {
            if (timeoutId) clearTimeout(timeoutId);
            unregister();
        }
    }, { control, ...retryOptions });
}

export function validateMultipartUpload(upload, fileSize) {
    if (upload?.type !== 'multipart' || !Number.isSafeInteger(upload.chunkSize) || upload.chunkSize <= 0) {
        throw new Error('multipart 上传凭证无效');
    }
    const parts = [...(upload.parts || [])].sort((a, b) => a.partNumber - b.partNumber);
    const expected = Math.ceil(fileSize / upload.chunkSize);
    if (parts.length !== expected || parts.some((part, index) => part.partNumber !== index + 1 || !part.url)) {
        throw new Error('multipart 分片数量或顺序无效');
    }
    return parts;
}

export function createMultipartCompletionPayload(oid, completedParts) {
    const parts = Object.entries(completedParts || {})
        .map(([partNumber, etag]) => ({ partNumber: Number(partNumber), etag: String(etag) }))
        .sort((a, b) => a.partNumber - b.partNumber);
    return { oid, parts };
}

function partSize(fileSize, chunkSize, partNumber) {
    const start = (partNumber - 1) * chunkSize;
    return Math.max(0, Math.min(chunkSize, fileSize - start));
}

export async function uploadMultipartFile({
    file,
    oid,
    upload,
    completedParts = {},
    pool,
    control,
    onProgress,
    onWireBytes,
    onPartComplete,
    onCompleting,
    onCompletionRetry,
    completionEndpoint = '/api/admin/hf/complete-multipart',
    completionTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
    fetchFn,
    xhrFactory,
    stallTimeoutMs,
    maxAttempts,
    sleepFn,
    random,
    onRetry
}) {
    const parts = validateMultipartUpload(upload, file.size);
    const resultParts = { ...completedParts };
    const ledger = new ProgressLedger((total) => onProgress?.(total, file.size));

    for (const part of parts) {
        if (resultParts[part.partNumber]) {
            ledger.set(part.partNumber, partSize(file.size, upload.chunkSize, part.partNumber));
        }
    }

    await Promise.all(parts.map((part) => {
        if (resultParts[part.partNumber]) return Promise.resolve();
        return pool.run(async () => {
            const start = (part.partNumber - 1) * upload.chunkSize;
            const end = Math.min(start + upload.chunkSize, file.size);
            const slice = file.slice(start, end);
            const response = await uploadBlob(part.url, slice, {
                control,
                xhrFactory,
                stallTimeoutMs,
                maxAttempts,
                sleepFn,
                random,
                onRetry,
                onWireBytes,
                onProgress: (loaded) => ledger.set(part.partNumber, loaded, slice.size)
            });
            if (!response.etag) throw new Error(`第 ${part.partNumber} 片上传成功但响应缺少 ETag`);
            resultParts[part.partNumber] = response.etag;
            ledger.set(part.partNumber, slice.size, slice.size);
            await onPartComplete?.(part.partNumber, response.etag);
        });
    }));

    const payload = createMultipartCompletionPayload(oid, resultParts);
    if (payload.parts.length !== parts.length) throw new Error('multipart 完成请求缺少 ETag');

    await onCompleting?.();
    await pool.run(() => fetchWithUploadRetry(completionEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ href: upload.href, ...payload })
    }, {
        control,
        fetchFn,
        expiredStatuses: [400, 401, 403, 404, 409, 410],
        requestTimeoutMs: completionTimeoutMs,
        maxAttempts,
        sleepFn,
        random,
        onRetry: onCompletionRetry || onRetry
    }), { priority: true });
    onProgress?.(file.size, file.size);
    return { parts: resultParts, payload };
}

export async function uploadBasicFile({
    file,
    upload,
    pool,
    control,
    onProgress,
    onWireBytes,
    xhrFactory,
    stallTimeoutMs,
    maxAttempts,
    sleepFn,
    random,
    onRetry
}) {
    await pool.run(() => uploadBlob(upload.href, file, {
        control,
        xhrFactory,
        stallTimeoutMs,
        maxAttempts,
        sleepFn,
        random,
        onRetry,
        onProgress,
        onWireBytes
    }));
    onProgress?.(file.size, file.size);
}
