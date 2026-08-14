import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    buildCommitNdjson,
    handleHfUploadApi,
    mapLfsBatchObjects,
    sanitizeUploadAction
} from '../worker/hf-upload.js';
import {
    ProgressLedger,
    UploadControl,
    UploadTaskPool,
    createMultipartCompletionPayload,
    fetchWithUploadRetry,
    isUploadActionExpired,
    uploadBasicFile,
    uploadMultipartFile
} from '../src/shared/hfUploadClient.js';
import { Sha256Stream } from '../src/shared/sha256.js';
import { reactive } from 'vue';
import { toStoredUploadFile } from '../src/shared/hfUploadSession.js';

const oidA = 'a'.repeat(64);
const oidB = 'b'.repeat(64);
const completionUrl = 'https://huggingface.co/api/complete_multipart' +
    '?uploadId=test-upload&bucket=hf-hub-lfs-us-east-1&prefix=repos%2Ftest' +
    '&expiration=Sat%2C+15+Aug+2026+20%3A54%3A55+GMT&signature=test-signature';

function tick() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function successfulXhr(xhr, { etag = '"etag"' } = {}) {
    queueMicrotask(() => {
        xhr.upload.onprogress?.({ loaded: xhr.body.size, total: xhr.body.size, lengthComputable: true });
        xhr.status = 200;
        xhr.etag = etag;
        xhr.onload?.();
    });
}

function xhrFactoryFor(handler) {
    return () => ({
        upload: {},
        status: 0,
        responseText: '',
        statusText: '',
        open(method, url) {
            this.method = method;
            this.url = url;
        },
        setRequestHeader() {},
        getResponseHeader(name) {
            return name.toLowerCase() === 'etag' ? (this.etag || null) : null;
        },
        send(body) {
            this.body = body;
            handler(this);
        },
        abort() {
            this.onabort?.();
        }
    });
}

// Worker 必须声明 multipart，并把 HF 的乱序响应按 oid 映射回原路径。
{
    const originalFetch = globalThis.fetch;
    let batchPayload;
    globalThis.fetch = async (_url, init) => {
        batchPayload = JSON.parse(init.body);
        return new Response(JSON.stringify({
            objects: [{
                oid: oidA,
                size: 8,
                actions: {
                    upload: {
                        href: completionUrl,
                        header: {
                            chunk_size: '4',
                            '00002': 'https://storage.example/part-2',
                            '00001': 'https://storage.example/part-1',
                            Authorization: 'must-not-leak'
                        }
                    }
                }
            }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
        const response = await handleHfUploadApi(new Request('https://local/api/admin/hf/prepare-upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                repo: 'owner/repo',
                files: [{ path: 'game/data.xp3', size: 8, sha256: oidA }]
            })
        }), { HF_TOKEN: 'secret' }, null, ['prepare-upload']);
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.deepEqual(batchPayload.transfers, ['basic', 'multipart']);
        assert.equal(batchPayload.hash_algo, 'sha256');
        assert.equal(body.objects[0].upload.type, 'multipart');
        assert.deepEqual(body.objects[0].upload.parts.map((part) => part.partNumber), [1, 2]);
        assert.equal(JSON.stringify(body).includes('must-not-leak'), false, 'non-multipart action headers must not leak');
    } finally {
        globalThis.fetch = originalFetch;
    }
}

// multipart completion 必须由 Worker 转发到固定 HF 端点，不能成为任意 URL 代理。
{
    const originalFetch = globalThis.fetch;
    let forwarded;
    globalThis.fetch = async (url, init) => {
        forwarded = { url, init };
        return new Response(null, { status: 200 });
    };
    try {
        const response = await handleHfUploadApi(new Request('https://local/api/admin/hf/complete-multipart', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                href: completionUrl,
                oid: oidA,
                parts: [{ partNumber: 1, etag: '"etag"' }]
            })
        }), {}, null, ['complete-multipart']);
        assert.equal(response.status, 200);
        assert.equal(forwarded.url, completionUrl);
        assert.deepEqual(JSON.parse(forwarded.init.body), {
            oid: oidA,
            parts: [{ partNumber: 1, etag: '"etag"' }]
        });

        forwarded = null;
        const rejected = await handleHfUploadApi(new Request('https://local/api/admin/hf/complete-multipart', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                href: completionUrl.replace('huggingface.co', 'example.com'),
                oid: oidA,
                parts: [{ partNumber: 1, etag: '"etag"' }]
            })
        }), {}, null, ['complete-multipart']);
        assert.equal(rejected.status, 400);
        assert.equal(forwarded, null);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

{
    const files = [
        { path: 'b.bin', sha256: oidB, size: 2 },
        { path: 'a.bin', sha256: oidA, size: 1 }
    ];
    const mapped = mapLfsBatchObjects(files, [
        { oid: oidA, size: 1, actions: {} },
        { oid: oidB, size: 2, error: { code: 422, message: 'rejected' } }
    ]);
    assert.equal(mapped[0].path, 'b.bin');
    assert.equal(mapped[0].exists, false, 'object errors are not dedup hits');
    assert.equal(mapped[0].error.message, 'rejected');
    assert.equal(mapped[1].exists, true);
}

assert.throws(() => sanitizeUploadAction({
    href: completionUrl,
    header: { chunk_size: 4, 1: 'https://storage.example/part-1' }
}, 8), /分片列表不完整/);

// 大批量必须由客户端拆批，Worker 单批上限钉在 100。
{
    const response = await handleHfUploadApi(new Request('https://local/api/admin/hf/prepare-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            repo: 'owner/repo',
            files: Array.from({ length: 101 }, (_, index) => ({
                path: `game/${index}.bin`, size: 1, sha256: oidA
            }))
        })
    }), { HF_TOKEN: 'secret' }, null, ['prepare-upload']);
    assert.equal(response.status, 400);
}

// 全局任务池无论分片属于哪个文件，都不能超过 5 路。
{
    const pool = new UploadTaskPool(5);
    let active = 0;
    let maximum = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tasks = Array.from({ length: 12 }, () => pool.run(async () => {
        active++;
        maximum = Math.max(maximum, active);
        await gate;
        active--;
    }));
    await tick();
    assert.equal(maximum, 5);
    release();
    await Promise.all(tasks);
}

// 文件完成请求要插到普通分片队列前面，避免大量文件同时停在 100%。
{
    const pool = new UploadTaskPool(1);
    const order = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const active = pool.run(() => gate);
    const normal = pool.run(() => { order.push('normal'); });
    const priority = pool.run(() => { order.push('completion'); }, { priority: true });
    release();
    await Promise.all([active, normal, priority]);
    assert.deepEqual(order, ['completion', 'normal']);
}

assert.deepEqual(createMultipartCompletionPayload(oidA, { 2: '"b"', 1: '"a"' }), {
    oid: oidA,
    parts: [
        { partNumber: 1, etag: '"a"' },
        { partNumber: 2, etag: '"b"' }
    ]
});

// 某片 500 时只重传该片；wire bytes 包含重传，logical progress 不重复累加。
{
    const attempts = new Map();
    let completionBody;
    let wireBytes = 0;
    const logicalSamples = [];
    const xhrFactory = xhrFactoryFor((xhr) => {
        const attempt = (attempts.get(xhr.url) || 0) + 1;
        attempts.set(xhr.url, attempt);
        queueMicrotask(() => {
            xhr.upload.onprogress?.({ loaded: xhr.body.size, total: xhr.body.size, lengthComputable: true });
            if (xhr.url.endsWith('part-2') && attempt === 1) {
                xhr.status = 500;
                xhr.responseText = 'retry';
            } else {
                xhr.status = 200;
                xhr.etag = `"part-${xhr.url.slice(-1)}"`;
            }
            xhr.onload?.();
        });
    });
    const result = await uploadMultipartFile({
        file: new Blob([new Uint8Array(8)]),
        oid: oidA,
        upload: {
            type: 'multipart',
            href: completionUrl,
            chunkSize: 4,
            parts: [
                { partNumber: 1, url: 'https://storage.example/part-1' },
                { partNumber: 2, url: 'https://storage.example/part-2' }
            ]
        },
        completedParts: {},
        pool: new UploadTaskPool(5),
        control: new UploadControl(),
        xhrFactory,
        sleepFn: async () => {},
        random: () => 0,
        onWireBytes: (delta) => { wireBytes += delta; },
        onProgress: (loaded) => logicalSamples.push(loaded),
        fetchFn: async (url, init) => {
            assert.equal(url, '/api/admin/hf/complete-multipart');
            completionBody = JSON.parse(init.body);
            return new Response(null, { status: 200 });
        }
    });
    assert.equal(attempts.get('https://storage.example/part-1'), 1);
    assert.equal(attempts.get('https://storage.example/part-2'), 2);
    assert.equal(wireBytes, 12, 'wire speed includes the retransmitted four bytes');
    assert.equal(Math.max(...logicalSamples), 8, 'logical progress never exceeds the file size');
    assert.deepEqual(completionBody, { href: completionUrl, ...result.payload });
    assert.deepEqual(result.parts, { 1: '"part-1"', 2: '"part-2"' });
}

// 多文件同时完成时，completion 与 PUT 共用同一个并发上限。
{
    const pool = new UploadTaskPool(2);
    let active = 0;
    let maximum = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const uploads = Array.from({ length: 5 }, () => uploadMultipartFile({
        file: new Blob([new Uint8Array(1)]),
        oid: oidA,
        upload: {
            type: 'multipart',
            href: completionUrl,
            chunkSize: 1,
            parts: [{ partNumber: 1, url: 'https://storage.example/part-1' }]
        },
        completedParts: { 1: '"etag"' },
        pool,
        control: new UploadControl(),
        fetchFn: async (url) => {
            assert.equal(url, '/api/admin/hf/complete-multipart');
            active++;
            maximum = Math.max(maximum, active);
            await gate;
            active--;
            return new Response(null, { status: 200 });
        }
    }));
    await tick();
    assert.equal(maximum, 2);
    release();
    await Promise.all(uploads);
}

// 暂停会 abort 当前 XHR；继续时重开当前片，但不消耗失败重试次数。
{
    const control = new UploadControl();
    let sends = 0;
    let retryNotices = 0;
    const xhrFactory = xhrFactoryFor((xhr) => {
        sends++;
        if (sends > 1) successfulXhr(xhr);
    });
    const promise = uploadBasicFile({
        file: new Blob([new Uint8Array(4)]),
        upload: { type: 'basic', href: 'https://storage.example/basic' },
        pool: new UploadTaskPool(1),
        control,
        xhrFactory,
        sleepFn: async () => {},
        onRetry: () => { retryNotices++; }
    });
    await tick();
    control.pause();
    await tick();
    control.resume();
    await promise;
    assert.equal(sends, 2);
    assert.equal(retryNotices, 0);
}

// 真停滞才计为失败重试。
{
    let sends = 0;
    const xhrFactory = xhrFactoryFor((xhr) => {
        sends++;
        if (sends > 1) successfulXhr(xhr);
    });
    await uploadBasicFile({
        file: new Blob([new Uint8Array(4)]),
        upload: { type: 'basic', href: 'https://storage.example/stall' },
        pool: new UploadTaskPool(1),
        control: new UploadControl(),
        xhrFactory,
        stallTimeoutMs: 5,
        sleepFn: async () => {}
    });
    assert.equal(sends, 2);
}

{
    const samples = [];
    const ledger = new ProgressLedger((total) => samples.push(total));
    ledger.set('part', 4, 4);
    ledger.set('part', 0, 4);
    ledger.set('part', 4, 4);
    assert.deepEqual(samples, [4, 0, 4], 'retry replaces in-flight logical bytes instead of accumulating them');
}

assert.equal(isUploadActionExpired({ expiresAt: 1000 }, 950, 60), true);
assert.equal(isUploadActionExpired({ expiresAt: 2000 }, 950, 60), false);

{
    const control = new UploadControl();
    const delayed = control.delay(60000);
    control.cancel();
    await assert.rejects(delayed, { name: 'UploadCancelledError' });
}

// completion 无响应时必须主动中止并转成可重试错误。
await assert.rejects(fetchWithUploadRetry('/api/admin/hf/complete-multipart', {}, {
    requestTimeoutMs: 5,
    maxAttempts: 1,
    fetchFn: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
    })
}), (err) => err?.retryable === true && /无响应/.test(err.message));

// Vue 响应式 Proxy 必须在进入 IndexedDB 前转回可 structured-clone 的普通对象。
{
    const reactiveState = reactive({
        sessionId: 'session',
        path: 'data.xp3',
        upload: {
            type: 'multipart',
            href: completionUrl,
            expiresAt: 123,
            chunkSize: 4,
            parts: [{ partNumber: 1, url: 'https://storage.example/part-1' }]
        },
        parts: { 1: '"etag"' }
    });
    const stored = toStoredUploadFile(reactiveState);
    assert.doesNotThrow(() => structuredClone(stored));
    assert.equal(stored.upload.parts[0].url, 'https://storage.example/part-1');
    assert.deepEqual(stored.parts, { 1: '"etag"' });
}

// 增量 SHA 与 Node SHA-256 对齐，覆盖 Worker 的大文件算法核心。
{
    const bytes = new TextEncoder().encode('krkr2 multipart upload sha256');
    const hasher = new Sha256Stream();
    hasher.update(bytes.subarray(0, 7));
    hasher.update(bytes.subarray(7, 19));
    hasher.update(bytes.subarray(19));
    assert.equal(hasher.digest(), createHash('sha256').update(bytes).digest('hex'));
}

const ndjson = buildCommitNdjson({
    summary: 'Upload test',
    description: '',
    operations: [{ key: 'lfsFile', value: { path: 'a', algo: 'sha256', oid: oidA, size: 1 } }]
});
assert.equal(ndjson.endsWith('\n'), true);
assert.equal(ndjson.trim().split('\n').length, 2);

console.log('Hugging Face upload tests passed');
