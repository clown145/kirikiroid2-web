<script setup>
import { computed, onUnmounted, ref, shallowRef, watch } from 'vue';
import {
    AlertCircle, CheckCircle2, Clock, CloudUpload, Copy, Folder, FolderOpen,
    Gauge, Package, Pause, Play, Plus, RotateCcw, Sparkles, Square, Trash2, X
} from '@lucide/vue';
import { toast } from '../shared/toast.js';
import { toPinyinSlug } from '../shared/pinyin.js';
import { FileHasher } from '../shared/fileHasher.js';
import {
    DEFAULT_UPLOAD_CONCURRENCY,
    UploadActionExpiredError,
    UploadCancelledError,
    UploadControl,
    UploadTaskPool,
    fetchWithUploadRetry,
    isUploadActionExpired,
    uploadBasicFile,
    uploadMultipartFile
} from '../shared/hfUploadClient.js';
import {
    deleteUploadSession,
    getLatestUploadSession,
    listUploadFiles,
    newUploadSessionId,
    patchUploadFile,
    patchUploadSession,
    saveCompletedPart,
    saveUploadFiles,
    saveUploadSession
} from '../shared/hfUploadSession.js';
import { UploadSpeedTracker } from '../shared/uploadSpeed.js';

const HASH_BATCH_FILES = 20;
const HASH_BATCH_BYTES = 256 * 1024 * 1024;
const MAX_IN_FLIGHT_BATCHES = 2;
const ACTION_FALLBACK_TTL_MS = 25 * 60 * 1000;
const MAX_COMMIT_FILES = 9999;

const props = defineProps({
    show: { type: Boolean, default: false }
});
const emit = defineEmits(['close', 'complete']);

const step = ref('select');
const runState = ref('idle'); // idle | running | paused | stopped | failed
const phase = ref('idle'); // hashing | preparing | uploading | verifying | committing
const targetRepo = ref('clown145/gal');
const gameTitle = ref('');
const gameSlug = ref('');
const files = ref([]);
const hasExistingManifest = ref(false);
const generatedManifest = ref('');
const resumeCandidate = shallowRef(null);
const errorMessage = ref('');

const totalBytes = ref(0);
const uploadedBytes = ref(0);
const hashingBytes = ref(0);
const totalHashBytes = ref(0);
const wireBytes = ref(0);
const currentSpeed = ref('--');
const timeRemaining = ref('--');
const currentTaskMsg = ref('');
const completedCommitUrl = ref('');
const proxiedManifestUrl = ref('');

const dirInput = ref(null);
const isDragging = ref(false);

let currentDirHandle = null;
let sourceKind = 'input';
let sessionId = '';
let pendingResumeSession = null;
let currentControl = null;
let currentPool = null;
let runAbortController = null;
let pipelinePromise = null;
let stoppingForLater = false;
let speedTimer = null;
let persistenceEnabled = true;
let persistenceWarningShown = false;

const speedTracker = new UploadSpeedTracker();
const fileHasher = new FileHasher();

function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    return `${(value / (1024 ** index)).toFixed(2)} ${units[index]}`;
}

function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '--';
    const rounded = Math.ceil(seconds);
    if (rounded >= 3600) return `${Math.floor(rounded / 3600)} 小时 ${Math.floor((rounded % 3600) / 60)} 分`;
    if (rounded >= 60) return `${Math.floor(rounded / 60)} 分 ${rounded % 60} 秒`;
    return `${rounded} 秒`;
}

const overallPercent = computed(() => totalBytes.value
    ? Math.min(100, Math.round((uploadedBytes.value / totalBytes.value) * 100))
    : (files.value.length && files.value.every((item) => ['done', 'dedup'].includes(item.status)) ? 100 : 0));
const hashPercent = computed(() => totalHashBytes.value
    ? Math.min(100, Math.round((hashingBytes.value / totalHashBytes.value) * 100))
    : 0);
const phaseText = computed(() => ({
    idle: '等待开始',
    hashing: '计算 SHA-256',
    preparing: '申请上传通道',
    uploading: '上传文件',
    verifying: '校验对象',
    committing: '创建 Commit'
}[phase.value] || phase.value));

async function persist(operation) {
    if (!persistenceEnabled) return;
    try {
        await operation();
    } catch (err) {
        persistenceEnabled = false;
        if (!persistenceWarningShown) {
            persistenceWarningShown = true;
            toast.warn(`无法保存断点状态，本次页面关闭后不能恢复：${err.message}`);
        }
    }
}

function buildFileRecord(name, file, handle = null) {
    return {
        name: name.replace(/\\/g, '/'),
        handle,
        file,
        size: file.size,
        lastModified: file.lastModified,
        sha256: '',
        status: 'pending',
        progress: 0,
        hashProgress: 0,
        uploaded: 0,
        uploadedComplete: false,
        verified: false,
        upload: null,
        parts: {},
        retryCount: 0,
        error: ''
    };
}

async function scanHandle(dirHandle, relativePath = '') {
    let result = [];
    for await (const [name, handle] of dirHandle.entries()) {
        if (name === '.DS_Store' || name === 'Thumbs.db' || name.toLowerCase().endsWith('.exe')) continue;
        const path = relativePath ? `${relativePath}/${name}` : name;
        if (handle.kind === 'directory') {
            result = result.concat(await scanHandle(handle, path));
        } else if (handle.kind === 'file') {
            result.push(buildFileRecord(path, await handle.getFile(), handle));
        }
    }
    return result;
}

function createManifest(resources) {
    return JSON.stringify(resources.map((file) => ({ name: file.name, size: file.size })), null, 2);
}

function completedPartBytes(state) {
    if (state.status === 'done' || state.status === 'dedup' || state.uploadedComplete) return state.size;
    if (state.upload?.type !== 'multipart') return 0;
    return Object.keys(state.parts || {}).reduce((total, key) => {
        const partNumber = Number(key);
        const start = (partNumber - 1) * state.upload.chunkSize;
        return total + Math.max(0, Math.min(state.upload.chunkSize, state.size - start));
    }, 0);
}

async function setupScannedFiles(scanned, { resume = null } = {}) {
    if (!scanned.length) throw new Error('未在选择的文件夹中发现有效游戏资源');
    hasExistingManifest.value = scanned.some((file) => file.name.toLowerCase() === 'manifest.json');
    const resources = scanned
        .filter((file) => file.name.toLowerCase() !== 'manifest.json')
        .sort((a, b) => a.name.localeCompare(b.name));
    if (!resources.length) throw new Error('目录中只有 manifest.json，没有可上传资源');

    generatedManifest.value = createManifest(resources);
    totalBytes.value = resources.reduce((total, file) => total + file.size, 0);
    totalHashBytes.value = totalBytes.value;
    hashingBytes.value = 0;
    uploadedBytes.value = 0;

    if (!resume) {
        files.value = resources;
        step.value = 'select';
        runState.value = 'idle';
        return;
    }

    const storedFiles = await listUploadFiles(resume.id);
    const storedByPath = new Map(storedFiles.map((file) => [file.path, file]));
    if (storedFiles.length !== resources.length) {
        throw new Error('目录文件数量已变化，不能套用旧断点');
    }

    for (const file of resources) {
        const state = storedByPath.get(file.name);
        if (!state || state.size !== file.size || state.lastModified !== file.lastModified) {
            throw new Error(`文件已变化，不能继续旧断点：${file.name}`);
        }
        Object.assign(file, {
            sha256: state.sha256 || '',
            status: ['done', 'dedup'].includes(state.status) ? state.status : 'pending',
            progress: ['done', 'dedup'].includes(state.status) ? 100 : 0,
            hashProgress: state.sha256 ? 100 : 0,
            uploadedComplete: !!state.uploadedComplete,
            verified: !!state.verified,
            upload: state.upload || null,
            parts: state.parts || {},
            retryCount: state.retryCount || 0,
            error: ''
        });
        file.uploaded = completedPartBytes({ ...state, size: file.size });
        hashingBytes.value += file.sha256 ? file.size : 0;
        uploadedBytes.value += file.uploaded;
    }

    files.value = resources;
    sessionId = resume.id;
    targetRepo.value = resume.repo;
    gameTitle.value = resume.title;
    gameSlug.value = resume.slug;
    generatedManifest.value = resume.manifest || generatedManifest.value;
    phase.value = resume.phase || 'hashing';
    step.value = 'uploading';
    runState.value = 'stopped';
    currentTaskMsg.value = '断点已载入，可以继续上传';
    resumeCandidate.value = resume;
}

async function onPickFolder() {
    if (typeof window.showDirectoryPicker !== 'function') {
        dirInput.value?.click();
        return;
    }
    try {
        const handle = await window.showDirectoryPicker({ mode: 'read' });
        currentDirHandle = handle;
        sourceKind = 'fsa';
        gameTitle.value = handle.name || 'Game';
        gameSlug.value = toPinyinSlug(gameTitle.value);
        toast.info('正在扫描文件...');
        await setupScannedFiles(await scanHandle(handle));
    } catch (err) {
        if (err?.name !== 'AbortError') toast.error(err.message || '读取文件夹失败');
    }
}

async function onInputFolderSelect(event) {
    const inputFiles = Array.from(event.target.files || []);
    event.target.value = '';
    if (!inputFiles.length) return;

    const firstPath = inputFiles[0].webkitRelativePath || '';
    const rootName = firstPath.split('/')[0] || 'Game';
    const scanned = inputFiles
        .filter((file) => file.name !== '.DS_Store' && file.name !== 'Thumbs.db' && !file.name.toLowerCase().endsWith('.exe'))
        .map((file) => buildFileRecord(
            (file.webkitRelativePath || file.name).replace(/^[^/]+\//, ''),
            file
        ));
    sourceKind = 'input';
    currentDirHandle = null;

    try {
        if (pendingResumeSession) {
            const resume = pendingResumeSession;
            pendingResumeSession = null;
            await setupScannedFiles(scanned, { resume });
        } else {
            gameTitle.value = rootName;
            gameSlug.value = toPinyinSlug(rootName);
            await setupScannedFiles(scanned);
        }
    } catch (err) {
        toast.error(err.message);
    }
}

function onDrop() {
    isDragging.value = false;
    toast.info('请使用文件夹选择器以保留完整目录结构');
}

async function resumePreviousUpload() {
    const resume = resumeCandidate.value;
    if (!resume) return;
    try {
        if (resume.sourceKind === 'fsa' && resume.directoryHandle) {
            const permission = await resume.directoryHandle.requestPermission({ mode: 'read' });
            if (permission !== 'granted') throw new Error('未获得文件夹读取权限');
            currentDirHandle = resume.directoryHandle;
            sourceKind = 'fsa';
            await setupScannedFiles(await scanHandle(currentDirHandle), { resume });
        } else {
            pendingResumeSession = resume;
            dirInput.value?.click();
        }
    } catch (err) {
        toast.error(`无法恢复上传：${err.message}`);
    }
}

async function discardResume() {
    const resume = resumeCandidate.value;
    if (!resume) return;
    try {
        await deleteUploadSession(resume.id);
        resumeCandidate.value = null;
        toast.info('已删除旧上传断点');
    } catch (err) {
        toast.error(`删除上传断点失败：${err.message}`);
    }
}

async function getActiveFile(item) {
    const file = item.handle ? await item.handle.getFile() : item.file;
    if (!file || file.size !== item.size || file.lastModified !== item.lastModified) {
        throw new Error(`文件在校验后发生变化，请重新选择目录：${item.name}`);
    }
    return file;
}

function updateItemUploaded(item, loaded) {
    const value = Math.max(0, Math.min(Number(loaded) || 0, item.size));
    uploadedBytes.value += value - item.uploaded;
    item.uploaded = value;
    item.progress = item.size ? Math.round((value / item.size) * 100) : 100;
}

function recordWireBytes(delta) {
    wireBytes.value += delta;
    speedTracker.record(wireBytes.value);
}

function startSpeedMonitor() {
    stopSpeedMonitor();
    speedTracker.reset();
    wireBytes.value = 0;
    currentSpeed.value = '--';
    timeRemaining.value = '--';
    speedTimer = setInterval(() => {
        if (runState.value === 'paused') {
            currentSpeed.value = '已暂停';
            timeRemaining.value = '--';
            return;
        }
        const speed = speedTracker.getSpeed();
        currentSpeed.value = speed > 0 ? `${formatBytes(speed)}/s` : (wireBytes.value ? '0 B/s' : '--');
        const remaining = Math.max(0, totalBytes.value - uploadedBytes.value);
        timeRemaining.value = speed > 0 && remaining > 0 ? formatDuration(remaining / speed) : '--';
    }, 800);
}

function stopSpeedMonitor() {
    if (speedTimer) clearInterval(speedTimer);
    speedTimer = null;
}

function retryNotice(item, label) {
    return ({ attempt, delay, error }) => {
        item.retryCount++;
        item.error = `${label}失败，${Math.ceil(delay / 1000)} 秒后第 ${attempt} 次尝试`;
        currentTaskMsg.value = `${item.name} 正在重试：${error.message}`;
    };
}

async function requestJson(url, init, item = null, label = '请求') {
    const response = await fetchWithUploadRetry(url, init, {
        control: currentControl,
        onRetry: item ? retryNotice(item, label) : ({ attempt }) => {
            currentTaskMsg.value = `${label}失败，正在进行第 ${attempt} 次尝试`;
        }
    });
    return response.json();
}

async function prepareItems(items) {
    if (!items.length) return new Map();
    phase.value = 'preparing';
    for (let attempt = 1; attempt <= 3; attempt++) {
        currentTaskMsg.value = `正在申请 ${items.length} 个 LFS 上传通道`;
        const result = await requestJson('/api/admin/hf/prepare-upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                repo: targetRepo.value.trim(),
                files: items.map((item) => ({
                    path: `${gameSlug.value}/${item.name}`,
                    size: item.size,
                    sha256: item.sha256
                }))
            })
        }, null, 'LFS Batch');
        const objects = result.objects || [];
        const temporaryErrors = objects.filter((object) => {
            const code = Number(object.error?.code) || 0;
            return code === 408 || code === 425 || code === 429 || code >= 500;
        });
        if (!temporaryErrors.length || attempt === 3) {
            return new Map(objects.map((object) => [object.path, object]));
        }
        for (const object of temporaryErrors) {
            const item = items.find((candidate) => `${gameSlug.value}/${candidate.name}` === object.path);
            if (item) item.retryCount++;
        }
        currentTaskMsg.value = `LFS Batch 返回临时错误，正在第 ${attempt + 1} 次尝试`;
        await currentControl.delay(500 * (2 ** (attempt - 1)));
    }
    return new Map();
}

function normalizeUploadAction(upload) {
    if (!upload) return null;
    return {
        ...upload,
        expiresAt: upload.expiresAt || (Date.now() + ACTION_FALLBACK_TTL_MS)
    };
}

function isSameUploadSession(previous, next) {
    if (!previous || !next || previous.type !== next.type || previous.href !== next.href) return false;
    if (previous.type !== 'multipart') return true;
    if (previous.chunkSize !== next.chunkSize || previous.parts?.length !== next.parts?.length) return false;
    return previous.parts.every((part, index) =>
        part.partNumber === next.parts[index]?.partNumber && part.url === next.parts[index]?.url);
}

async function verifyItem(item) {
    phase.value = 'verifying';
    item.status = 'verifying';
    currentTaskMsg.value = `正在校验 LFS 对象：${item.name}`;
    await requestJson('/api/admin/hf/verify-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: targetRepo.value.trim(), oid: item.sha256, size: item.size })
    }, item, 'LFS Verify');
    item.verified = true;
    await persist(() => patchUploadFile(sessionId, item.name, { verified: true, status: 'verifying' }));
}

async function markDeduplicated(item) {
    item.status = 'dedup';
    item.uploadedComplete = true;
    item.verified = true;
    item.error = '';
    updateItemUploaded(item, item.size);
    await persist(() => patchUploadFile(sessionId, item.name, {
        status: 'dedup', uploadedComplete: true, verified: true, upload: null, parts: {}
    }));
}

async function uploadOneFile(item, initialMeta) {
    if (item.status === 'done' || item.status === 'dedup') return;
    let meta = initialMeta;
    let refreshCount = 0;

    if (item.uploadedComplete) {
        if (!item.verified && item.upload?.type === 'basic') await verifyItem(item);
        item.status = 'done';
        item.verified = true;
        updateItemUploaded(item, item.size);
        await persist(() => patchUploadFile(sessionId, item.name, { status: 'done', verified: true }));
        return;
    }

    for (;;) {
        await currentControl.waitUntilRunning();
        if (!meta) {
            const prepared = await prepareItems([item]);
            meta = prepared.get(`${gameSlug.value}/${item.name}`);
        }
        if (!meta) throw new Error(`LFS Batch 未返回文件：${item.name}`);
        if (meta.error) throw new Error(`${item.name}: ${meta.error.message}`);
        if (meta.exists) {
            await markDeduplicated(item);
            return;
        }

        const nextUpload = normalizeUploadAction(meta.upload || item.upload);
        if (!nextUpload) throw new Error(`无法获取文件 ${item.name} 的上传凭证`);
        if (item.upload && !isSameUploadSession(item.upload, nextUpload)) {
            item.parts = {};
            updateItemUploaded(item, 0);
        }
        item.upload = nextUpload;

        if (isUploadActionExpired(item.upload)) {
            if (refreshCount++ >= 2) throw new Error(`${item.name} 的上传凭证反复过期`);
            item.upload = null;
            item.parts = {};
            updateItemUploaded(item, 0);
            meta = null;
            continue;
        }

        item.status = 'uploading';
        item.error = '';
        phase.value = 'uploading';
        currentTaskMsg.value = `正在并行上传：${item.name}`;
        await persist(() => patchUploadFile(sessionId, item.name, {
            status: 'uploading', upload: item.upload, parts: item.parts, retryCount: item.retryCount
        }));

        const activeFile = await getActiveFile(item);
        try {
            if (item.upload.type === 'multipart') {
                const result = await uploadMultipartFile({
                    file: activeFile,
                    oid: item.sha256,
                    upload: item.upload,
                    completedParts: item.parts,
                    pool: currentPool,
                    control: currentControl,
                    onProgress: (loaded) => updateItemUploaded(item, loaded),
                    onWireBytes: recordWireBytes,
                    onRetry: retryNotice(item, '分片上传'),
                    onPartComplete: async (partNumber, etag) => {
                        item.parts = { ...item.parts, [partNumber]: etag };
                        await persist(() => saveCompletedPart(sessionId, item.name, partNumber, etag));
                    }
                });
                item.parts = result.parts;
                item.verified = true;
            } else {
                await uploadBasicFile({
                    file: activeFile,
                    upload: item.upload,
                    pool: currentPool,
                    control: currentControl,
                    onProgress: (loaded) => updateItemUploaded(item, loaded),
                    onWireBytes: recordWireBytes,
                    onRetry: retryNotice(item, '文件上传')
                });
            }
        } catch (err) {
            if (!(err instanceof UploadActionExpiredError)) throw err;
            if (refreshCount++ >= 2) throw err;
            item.upload = null;
            item.parts = {};
            item.uploadedComplete = false;
            updateItemUploaded(item, 0);
            await persist(() => patchUploadFile(sessionId, item.name, {
                upload: null, parts: {}, uploadedComplete: false, status: 'pending'
            }));
            meta = null;
            continue;
        }

        item.uploadedComplete = true;
        updateItemUploaded(item, item.size);
        await persist(() => patchUploadFile(sessionId, item.name, {
            upload: item.upload,
            parts: item.parts,
            uploadedComplete: true,
            verified: item.verified,
            retryCount: item.retryCount
        }));
        if (item.upload.type === 'basic' && !item.verified) await verifyItem(item);

        item.status = 'done';
        item.progress = 100;
        item.error = '';
        await persist(() => patchUploadFile(sessionId, item.name, {
            status: 'done', uploadedComplete: true, verified: true, retryCount: item.retryCount
        }));
        return;
    }
}

async function processUploadBatch(batch) {
    const needPrepare = batch.filter((item) => !item.upload || isUploadActionExpired(item.upload));
    const prepared = await prepareItems(needPrepare);
    const results = await Promise.allSettled(batch.map(async (item) => {
        const path = `${gameSlug.value}/${item.name}`;
        const meta = prepared.get(path) || (item.upload ? { path, exists: false, upload: item.upload } : null);
        try {
            await uploadOneFile(item, meta);
        } catch (err) {
            if (err instanceof UploadCancelledError || currentControl?.cancelled) {
                item.status = 'pending';
                item.error = '';
                await persist(() => patchUploadFile(sessionId, item.name, {
                    status: 'pending', error: '', retryCount: item.retryCount
                }));
                throw err;
            }
            item.status = 'error';
            item.error = err.message;
            await persist(() => patchUploadFile(sessionId, item.name, {
                status: 'error', error: err.message, retryCount: item.retryCount
            }));
            throw err;
        }
    }));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
}

async function initializeSession() {
    const previous = resumeCandidate.value;
    sessionId = newUploadSessionId();
    generatedManifest.value = createManifest(files.value);
    await persist(() => saveUploadSession({
        id: sessionId,
        repo: targetRepo.value.trim(),
        title: gameTitle.value.trim(),
        slug: gameSlug.value.trim(),
        sourceKind,
        directoryHandle: sourceKind === 'fsa' ? currentDirHandle : null,
        manifest: generatedManifest.value,
        phase: 'hashing',
        status: 'active',
        fileCount: files.value.length,
        totalBytes: totalBytes.value,
        createdAt: Date.now()
    }));
    await persist(() => saveUploadFiles(files.value.map((item) => ({
        sessionId,
        path: item.name,
        size: item.size,
        lastModified: item.lastModified,
        sha256: '',
        status: 'pending',
        upload: null,
        parts: {},
        uploadedComplete: false,
        verified: false,
        retryCount: 0
    }))));
    if (previous?.id && previous.id !== sessionId) await persist(() => deleteUploadSession(previous.id));
    resumeCandidate.value = null;
}

function bytesToBase64(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

async function commitUpload() {
    phase.value = 'committing';
    currentTaskMsg.value = '文件已就绪，正在创建 Hugging Face Commit';
    await persist(() => patchUploadSession(sessionId, { phase: 'committing', status: 'active' }));
    const operations = [
        ...files.value.map((item) => ({
            operation: 'lfsFile',
            path: `${gameSlug.value}/${item.name}`,
            oid: item.sha256,
            size: item.size
        })),
        {
            operation: 'file',
            path: `${gameSlug.value}/manifest.json`,
            content: bytesToBase64(generatedManifest.value),
            encoding: 'base64'
        }
    ];
    return requestJson('/api/admin/hf/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            repo: targetRepo.value.trim(),
            branch: 'main',
            summary: `Upload ${gameTitle.value.trim()} (${gameSlug.value.trim()}) via WebUI`,
            operations
        })
    }, null, 'Commit');
}

async function runPipeline(createSession) {
    step.value = 'uploading';
    runState.value = 'running';
    errorMessage.value = '';
    stoppingForLater = false;
    currentControl = new UploadControl();
    currentPool = new UploadTaskPool(DEFAULT_UPLOAD_CONCURRENCY);
    runAbortController = new AbortController();
    startSpeedMonitor();

    try {
        if (createSession) await initializeSession();
        await persist(() => patchUploadSession(sessionId, { status: 'active', phase: 'hashing' }));

        phase.value = 'hashing';
        let completedHashBytes = files.value.reduce((total, item) => total + (item.sha256 ? item.size : 0), 0);
        hashingBytes.value = completedHashBytes;
        let batch = [];
        let batchBytes = 0;
        const inFlightBatches = new Set();
        let firstError = null;

        const dispatchBatch = async () => {
            if (!batch.length) return;
            const selected = batch;
            batch = [];
            batchBytes = 0;
            let promise;
            promise = processUploadBatch(selected)
                .catch((err) => { firstError ||= err; })
                .finally(() => inFlightBatches.delete(promise));
            inFlightBatches.add(promise);
            if (inFlightBatches.size >= MAX_IN_FLIGHT_BATCHES) await Promise.race(inFlightBatches);
        };

        for (let index = 0; index < files.value.length; index++) {
            if (firstError) break;
            const item = files.value[index];
            if (item.status === 'done' || item.status === 'dedup') continue;
            await currentControl.waitUntilRunning();

            if (!item.sha256) {
                item.status = 'hashing';
                item.error = '';
                currentTaskMsg.value = `正在校验文件 (${index + 1}/${files.value.length})：${item.name}`;
                const file = await getActiveFile(item);
                const base = completedHashBytes;
                try {
                    item.sha256 = await fileHasher.hash(file, {
                        signal: runAbortController.signal,
                        onProgress: (loaded, total) => {
                            item.hashProgress = total ? Math.round((loaded / total) * 100) : 100;
                            hashingBytes.value = base + loaded;
                        }
                    });
                } catch (err) {
                    item.status = 'error';
                    throw err;
                }
                completedHashBytes += item.size;
                hashingBytes.value = completedHashBytes;
                item.hashProgress = 100;
                item.status = 'pending';
                await persist(() => patchUploadFile(sessionId, item.name, {
                    sha256: item.sha256, status: 'pending', error: ''
                }));
            }

            batch.push(item);
            batchBytes += item.size;
            if (batch.length >= HASH_BATCH_FILES || batchBytes >= HASH_BATCH_BYTES) await dispatchBatch();
        }

        if (!firstError) await dispatchBatch();
        await Promise.all(inFlightBatches);
        if (firstError) throw firstError;
        if (files.value.some((item) => !['done', 'dedup'].includes(item.status))) {
            throw new Error('仍有文件未完成上传');
        }

        const commitResult = await commitUpload();
        completedCommitUrl.value = commitResult.commitUrl || '';
        const repoName = targetRepo.value.split('/')[1] || 'gal';
        proxiedManifestUrl.value = `${window.location.origin}/hf/${repoName}/${gameSlug.value}/manifest.json`;
        try {
            await deleteUploadSession(sessionId);
        } catch {
            // Commit 已成功，清理失败不能把整个上传改判为失败。
        }
        resumeCandidate.value = null;
        runState.value = 'idle';
        step.value = 'completed';
        currentTaskMsg.value = '上传与 Commit 已完成';
        toast.success('上传成功并已完成 Commit');
    } catch (err) {
        const stopped = stoppingForLater || currentControl?.cancelled ||
            err instanceof UploadCancelledError || err?.name === 'AbortError';
        for (const item of files.value) {
            if (item.status === 'hashing') item.status = 'pending';
        }
        if (stopped) {
            runState.value = 'stopped';
            currentSpeed.value = '--';
            timeRemaining.value = '--';
            currentTaskMsg.value = persistenceEnabled ? '上传已停止，断点已保存' : '上传已停止，断点保存失败';
            await persist(() => patchUploadSession(sessionId, { status: 'paused', phase: phase.value }));
        } else {
            runState.value = 'failed';
            errorMessage.value = err.message || '上传失败';
            currentTaskMsg.value = `上传中断：${errorMessage.value}`;
            await persist(() => patchUploadSession(sessionId, {
                status: 'failed', phase: phase.value, error: errorMessage.value
            }));
            toast.error(`上传失败：${errorMessage.value}`);
        }
    } finally {
        stopSpeedMonitor();
        runAbortController = null;
    }
}

function launchPipeline(createSession = false) {
    if (pipelinePromise) return pipelinePromise;
    pipelinePromise = runPipeline(createSession).finally(() => {
        pipelinePromise = null;
    });
    return pipelinePromise;
}

function startUpload() {
    if (!files.value.length) return;
    gameTitle.value = gameTitle.value.trim();
    gameSlug.value = gameSlug.value.trim();
    targetRepo.value = targetRepo.value.trim();
    if (!gameTitle.value.trim() || !gameSlug.value.trim() || !targetRepo.value.trim()) {
        toast.error('游戏名称、目标目录和仓库不能为空');
        return;
    }
    if (files.value.length > MAX_COMMIT_FILES) {
        toast.error(`单次最多上传 ${MAX_COMMIT_FILES} 个资源文件`);
        return;
    }
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,95})\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,95})$/.test(targetRepo.value.trim())) {
        toast.error('Hugging Face 仓库必须是 owner/name 格式');
        return;
    }
    if (/[\\/\u0000-\u001f\u007f]/.test(gameSlug.value) || ['.', '..'].includes(gameSlug.value)) {
        toast.error('目标目录不能包含路径分隔符或控制字符');
        return;
    }
    launchPipeline(true);
}

async function pauseUpload() {
    if (runState.value !== 'running') return;
    currentControl?.pause();
    runState.value = 'paused';
    currentTaskMsg.value = '上传已暂停，已完成分片会保留';
    await persist(() => patchUploadSession(sessionId, { status: 'paused', phase: phase.value }));
}

async function continueUpload() {
    if (runState.value === 'paused' && pipelinePromise) {
        runState.value = 'running';
        currentControl?.resume();
        currentTaskMsg.value = '正在继续上传';
        await persist(() => patchUploadSession(sessionId, { status: 'active', phase: phase.value }));
        return;
    }
    launchPipeline(false);
}

async function stopForLater() {
    if (!pipelinePromise) {
        runState.value = 'stopped';
        return;
    }
    stoppingForLater = true;
    currentControl?.cancel();
    runAbortController?.abort(new UploadCancelledError());
    await persist(() => patchUploadSession(sessionId, { status: 'paused', phase: phase.value }));
    await pipelinePromise;
}

async function handleClose() {
    if (runState.value === 'running') return;
    if (runState.value === 'paused') await stopForLater();
    emit('close');
}

function retryUpload() {
    for (const item of files.value) {
        if (item.status === 'error') {
            item.status = 'pending';
            item.error = '';
        }
    }
    launchPipeline(false);
}

function copyUrl() {
    if (!proxiedManifestUrl.value) return;
    navigator.clipboard.writeText(proxiedManifestUrl.value);
    toast.success('已复制代理清单链接');
}

function handleCreateGameDirectly() {
    const xp3Files = files.value.filter((file) => file.name.toLowerCase().endsWith('.xp3'));
    const dataXp3 = xp3Files.find((file) => file.name.toLowerCase() === 'data.xp3');
    emit('complete', {
        title: gameTitle.value,
        downloadUrl: proxiedManifestUrl.value,
        entryXp3: dataXp3?.name || xp3Files[0]?.name || ''
    });
    emit('close');
}

async function resetForOpen() {
    step.value = 'select';
    runState.value = 'idle';
    phase.value = 'idle';
    files.value = [];
    totalBytes.value = 0;
    totalHashBytes.value = 0;
    uploadedBytes.value = 0;
    hashingBytes.value = 0;
    wireBytes.value = 0;
    errorMessage.value = '';
    currentTaskMsg.value = '';
    currentDirHandle = null;
    sessionId = '';
    pendingResumeSession = null;
    persistenceEnabled = true;
    persistenceWarningShown = false;
    stopSpeedMonitor();
    try {
        resumeCandidate.value = await getLatestUploadSession();
    } catch {
        resumeCandidate.value = null;
        persistenceEnabled = false;
    }
}

watch(() => props.show, (visible) => {
    if (visible) resetForOpen();
}, { immediate: true });

onUnmounted(() => {
    currentControl?.cancel();
    runAbortController?.abort(new UploadCancelledError());
    stopSpeedMonitor();
    fileHasher.destroy();
});
</script>

<template>
    <div v-if="show" class="hf-modal-backdrop" @click.self="handleClose">
        <div class="hf-modal">
            <header class="hf-head">
                <div class="hf-head-title">
                    <CloudUpload class="hf-logo" :size="20" aria-hidden="true" />
                    <h2>上传游戏到 Hugging Face</h2>
                </div>
                <button
                    v-if="runState !== 'running'"
                    class="btn btn-ghost btn-sm icon-button"
                    title="关闭"
                    aria-label="关闭"
                    @click="handleClose">
                    <X :size="16" />
                </button>
            </header>

            <div class="hf-body">
                <div v-if="step === 'select'" class="step-select">
                    <div v-if="resumeCandidate" class="resume-banner">
                        <div class="resume-info">
                            <RotateCcw :size="18" aria-hidden="true" />
                            <div>
                                <strong>发现未完成上传</strong>
                                <span>{{ resumeCandidate.title }} · {{ resumeCandidate.repo }}/{{ resumeCandidate.slug }}</span>
                            </div>
                        </div>
                        <div class="resume-actions">
                            <button class="btn btn-sm btn-primary" @click="resumePreviousUpload">
                                <Play :size="14" aria-hidden="true" />
                                <span>继续</span>
                            </button>
                            <button class="btn btn-sm icon-button" title="删除断点" aria-label="删除断点" @click="discardResume">
                                <Trash2 :size="14" />
                            </button>
                        </div>
                    </div>

                    <div
                        class="dropzone"
                        :class="{ active: isDragging }"
                        @click="onPickFolder"
                        @dragover.prevent="isDragging = true"
                        @dragleave.prevent="isDragging = false"
                        @drop.prevent="onDrop">
                        <Folder class="drop-icon" :size="38" aria-hidden="true" />
                        <h3>{{ files.length ? gameTitle : '选择本地游戏文件夹' }}</h3>
                        <p class="drop-hint">
                            {{ files.length ? `${files.length} 个资源，${formatBytes(totalBytes)}` : '保留目录结构并扫描全部游戏资源' }}
                        </p>
                        <button class="btn btn-sm fallback-btn" type="button" @click.stop="dirInput?.click()">
                            <FolderOpen :size="14" aria-hidden="true" />
                            <span>备用文件选择器</span>
                        </button>
                        <input
                            ref="dirInput"
                            type="file"
                            webkitdirectory
                            directory
                            multiple
                            hidden
                            @change="onInputFolderSelect">
                    </div>

                    <div v-if="files.length" class="config-panel">
                        <div class="field-grid">
                            <div class="field-item">
                                <label>游戏名称</label>
                                <input v-model="gameTitle" class="input" placeholder="水葬银货">
                            </div>
                            <div class="field-item">
                                <label>目标目录</label>
                                <input v-model="gameSlug" class="input" placeholder="shuizangyinhuo">
                            </div>
                            <div class="field-item">
                                <label>Hugging Face 仓库</label>
                                <input v-model="targetRepo" class="input" placeholder="clown145/gal">
                            </div>
                            <div class="field-item">
                                <label>manifest.json</label>
                                <div class="manifest-status" :class="{ existing: hasExistingManifest }">
                                    <CheckCircle2 v-if="hasExistingManifest" :size="14" />
                                    <Sparkles v-else :size="14" />
                                    <span>{{ hasExistingManifest ? '将按当前目录重新生成' : '提交时自动生成' }}</span>
                                </div>
                            </div>
                        </div>

                        <div class="files-preview">
                            <div class="preview-head">
                                <span>待上传资源</span>
                                <span>{{ files.length }} 个 · {{ formatBytes(totalBytes) }}</span>
                            </div>
                            <div class="preview-list">
                                <div v-for="file in files.slice(0, 8)" :key="file.name" class="preview-item">
                                    <span class="file-name">{{ file.name }}</span>
                                    <span>{{ formatBytes(file.size) }}</span>
                                </div>
                                <div v-if="files.length > 8" class="preview-more">另外 {{ files.length - 8 }} 个文件</div>
                            </div>
                        </div>
                    </div>
                </div>

                <div v-else-if="step === 'uploading'" class="step-uploading">
                    <div class="progress-dashboard">
                        <div class="dash-top">
                            <div>
                                <span class="phase-label">{{ phaseText }}</span>
                                <span class="dash-title">{{ currentTaskMsg }}</span>
                            </div>
                            <span class="dash-pct">{{ overallPercent }}%</span>
                        </div>
                        <div class="bar-bg" role="progressbar" :aria-valuenow="overallPercent" aria-valuemin="0" aria-valuemax="100">
                            <div class="bar-fill" :style="{ width: overallPercent + '%' }" />
                        </div>
                        <div class="dash-meta">
                            <span><Package :size="13" /> 已完成 {{ formatBytes(uploadedBytes) }} / {{ formatBytes(totalBytes) }}</span>
                            <span><Gauge :size="13" /> {{ currentSpeed }}</span>
                            <span><Clock :size="13" /> {{ timeRemaining }}</span>
                        </div>
                        <div class="hash-row">
                            <span>SHA-256 {{ hashPercent }}%</span>
                            <span>{{ formatBytes(hashingBytes) }} / {{ formatBytes(totalHashBytes) }}</span>
                            <span v-if="wireBytes">网络已发送 {{ formatBytes(wireBytes) }}</span>
                        </div>
                    </div>

                    <div v-if="errorMessage" class="error-panel">
                        <AlertCircle :size="18" aria-hidden="true" />
                        <span>{{ errorMessage }}</span>
                    </div>

                    <div class="upload-files-table">
                        <div class="table-header">
                            <span class="col-file">文件路径</span>
                            <span class="col-size">大小</span>
                            <span class="col-status">状态</span>
                        </div>
                        <div class="table-body">
                            <div v-for="file in files" :key="file.name" class="table-row">
                                <span class="col-file" :title="file.name">{{ file.name }}</span>
                                <span class="col-size">{{ formatBytes(file.size) }}</span>
                                <span class="col-status" :title="file.error">
                                    <span v-if="file.status === 'pending'" class="badge badge-pending">等待</span>
                                    <span v-else-if="file.status === 'hashing'" class="badge badge-hash">哈希 {{ file.hashProgress }}%</span>
                                    <span v-else-if="file.status === 'uploading'" class="badge badge-uploading">
                                        {{ file.upload?.type === 'multipart' ? '分片' : '上传' }} {{ file.progress }}%
                                    </span>
                                    <span v-else-if="file.status === 'verifying'" class="badge badge-verify">校验</span>
                                    <span v-else-if="file.status === 'dedup'" class="badge badge-dedup">秒传</span>
                                    <span v-else-if="file.status === 'done'" class="badge badge-done">完成</span>
                                    <span v-else class="badge badge-err">失败</span>
                                    <small v-if="file.retryCount">重试 {{ file.retryCount }}</small>
                                </span>
                            </div>
                        </div>
                    </div>
                </div>

                <div v-else-if="step === 'completed'" class="step-completed">
                    <div class="complete-hero">
                        <CheckCircle2 :size="44" aria-hidden="true" />
                        <h3>上传完成</h3>
                        <p>资源已提交到 <code>{{ targetRepo }}/{{ gameSlug }}</code></p>
                    </div>
                    <div class="url-panel">
                        <label>代理清单地址</label>
                        <div class="url-input-group">
                            <input readonly :value="proxiedManifestUrl" class="input">
                            <button class="btn btn-sm icon-button" title="复制" aria-label="复制" @click="copyUrl">
                                <Copy :size="14" />
                            </button>
                        </div>
                    </div>
                    <div v-if="completedCommitUrl" class="commit-link">
                        <a :href="completedCommitUrl" target="_blank" rel="noopener">查看 Hugging Face Commit</a>
                    </div>
                </div>
            </div>

            <footer class="hf-foot">
                <div v-if="step === 'select'" class="footer-actions">
                    <button class="btn" @click="handleClose">取消</button>
                    <button class="btn btn-primary" :disabled="!files.length" @click="startUpload">
                        <CloudUpload :size="15" aria-hidden="true" />
                        <span>开始上传</span>
                    </button>
                </div>
                <div v-else-if="step === 'uploading'" class="footer-actions upload-actions">
                    <template v-if="runState === 'running'">
                        <button class="btn" @click="pauseUpload"><Pause :size="15" /><span>暂停</span></button>
                        <button class="btn btn-danger" @click="stopForLater"><Square :size="14" /><span>停止并保存断点</span></button>
                    </template>
                    <template v-else-if="runState === 'paused'">
                        <button class="btn btn-primary" @click="continueUpload"><Play :size="15" /><span>继续上传</span></button>
                        <button class="btn" @click="stopForLater"><Square :size="14" /><span>停止</span></button>
                    </template>
                    <template v-else-if="runState === 'failed'">
                        <button class="btn" @click="handleClose">关闭</button>
                        <button class="btn btn-primary" @click="retryUpload"><RotateCcw :size="15" /><span>重试失败阶段</span></button>
                    </template>
                    <template v-else>
                        <button class="btn" @click="handleClose">关闭</button>
                        <button class="btn btn-primary" @click="continueUpload"><Play :size="15" /><span>继续此上传</span></button>
                    </template>
                </div>
                <div v-else class="footer-actions">
                    <button class="btn" @click="handleClose">关闭</button>
                    <button class="btn btn-primary" @click="handleCreateGameDirectly">
                        <Plus :size="16" aria-hidden="true" />
                        <span>创建游戏条目</span>
                    </button>
                </div>
            </footer>
        </div>
    </div>
</template>

<style scoped>
.hf-modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    background: rgba(0, 0, 0, 0.72);
    backdrop-filter: blur(4px);
}

.hf-modal {
    display: flex;
    flex-direction: column;
    width: min(820px, 100%);
    max-height: 92vh;
    overflow: hidden;
    color: #e6e6eb;
    background: #1e1e24;
    border: 1px solid #35353f;
    border-radius: 8px;
    box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6);
}

.hf-head,
.hf-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 22px;
    background: #181820;
}

.hf-head { border-bottom: 1px solid #2d2d38; }
.hf-foot { justify-content: flex-end; border-top: 1px solid #2d2d38; }
.hf-head-title, .footer-actions, .resume-actions, .url-input-group { display: flex; align-items: center; gap: 10px; }
.hf-head h2 { margin: 0; font-size: 1.05rem; letter-spacing: 0; }
.hf-logo { color: #ffd21e; }
.hf-body { flex: 1; min-height: 0; padding: 22px; overflow-y: auto; }
.icon-button { width: 34px; min-width: 34px; padding: 0; justify-content: center; }

.resume-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    margin-bottom: 14px;
    padding: 12px 14px;
    background: #17251f;
    border: 1px solid #28543d;
    border-radius: 6px;
}

.resume-info { display: flex; align-items: center; gap: 10px; min-width: 0; color: #64d995; }
.resume-info div { display: flex; flex-direction: column; min-width: 0; }
.resume-info span { overflow: hidden; color: #9eb4a7; font-size: 0.78rem; text-overflow: ellipsis; white-space: nowrap; }

.dropzone {
    padding: 28px;
    text-align: center;
    cursor: pointer;
    background: #18181f;
    border: 2px dashed #444451;
    border-radius: 8px;
    transition: border-color 0.2s, background 0.2s;
}

.dropzone:hover, .dropzone.active { background: #202027; border-color: #ffd21e; }
.drop-icon { margin-bottom: 8px; color: #ffd21e; }
.dropzone h3 { margin: 0 0 5px; font-size: 1rem; letter-spacing: 0; }
.drop-hint { margin: 0; color: #9494a0; font-size: 0.82rem; }
.fallback-btn { margin-top: 14px; }

.config-panel { margin-top: 18px; }
.field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.field-item label, .url-panel label { display: block; margin-bottom: 6px; color: #a0a0b0; font-size: 0.78rem; }
.manifest-status {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 38px;
    padding: 0 11px;
    color: #ffd21e;
    font-size: 0.8rem;
    background: #2a2312;
    border: 1px solid #735314;
    border-radius: 5px;
}
.manifest-status.existing { color: #66d894; background: #14261c; border-color: #296340; }

.files-preview, .progress-dashboard, .url-panel {
    margin-top: 16px;
    padding: 14px;
    background: #17171e;
    border: 1px solid #2d2d38;
    border-radius: 7px;
}
.preview-head, .preview-item { display: flex; justify-content: space-between; gap: 16px; }
.preview-head { padding-bottom: 8px; color: #b5b5c2; font-size: 0.8rem; font-weight: 600; border-bottom: 1px solid #2a2a35; }
.preview-list { max-height: 150px; margin-top: 7px; overflow-y: auto; }
.preview-item { padding: 4px 0; color: #8e8e9c; font-size: 0.8rem; }
.file-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.preview-more { padding-top: 6px; color: #777785; font-size: 0.78rem; text-align: center; }

.progress-dashboard { margin-top: 0; padding: 18px; }
.dash-top { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-bottom: 12px; }
.dash-top > div { display: flex; flex-direction: column; min-width: 0; }
.phase-label { color: #ffd21e; font-size: 0.75rem; font-weight: 700; }
.dash-title { overflow: hidden; color: #b7b7c4; font-size: 0.82rem; text-overflow: ellipsis; white-space: nowrap; }
.dash-pct { flex: 0 0 auto; color: #fff; font-size: 1.35rem; font-weight: 700; }
.bar-bg { height: 10px; margin-bottom: 11px; overflow: hidden; background: #2b2b36; border-radius: 5px; }
.bar-fill { height: 100%; background: #f0bd24; transition: width 0.2s ease; }
.dash-meta, .hash-row { display: flex; justify-content: space-between; gap: 12px; color: #a2a2af; font-size: 0.78rem; }
.dash-meta span { display: inline-flex; align-items: center; gap: 5px; }
.hash-row { margin-top: 10px; padding-top: 9px; color: #7f8fa4; border-top: 1px solid #292934; }

.error-panel { display: flex; gap: 9px; margin-bottom: 14px; padding: 11px 13px; color: #fca5a5; font-size: 0.82rem; background: #30191b; border: 1px solid #693034; border-radius: 6px; }
.upload-files-table { overflow: hidden; font-size: 0.82rem; border: 1px solid #2d2d38; border-radius: 7px; }
.table-header, .table-row { display: grid; grid-template-columns: minmax(0, 1fr) 100px 150px; align-items: center; gap: 10px; padding: 9px 13px; }
.table-header { color: #9999a8; font-weight: 600; background: #16161d; border-bottom: 1px solid #2d2d38; }
.table-body { max-height: 310px; overflow-y: auto; background: #1b1b23; }
.table-row { border-bottom: 1px solid #262630; }
.col-file { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.col-size { color: #8c8c99; }
.col-status { display: flex; align-items: center; gap: 6px; }
.col-status small { color: #9d7d56; font-size: 0.68rem; }
.badge { display: inline-block; padding: 2px 7px; font-size: 0.72rem; white-space: nowrap; border-radius: 4px; }
.badge-pending { color: #a0a0b0; background: #2c2c38; }
.badge-hash { color: #7dc0ff; background: #1c2e3d; }
.badge-uploading { color: #fbbf24; background: #382c12; }
.badge-verify { color: #c4a7ff; background: #2c2340; }
.badge-dedup, .badge-done { color: #4ade80; background: #14331e; }
.badge-err { color: #f87171; background: #3b1818; }

.complete-hero { padding: 24px 0 8px; color: #4ade80; text-align: center; }
.complete-hero h3 { margin: 8px 0 5px; font-size: 1.2rem; letter-spacing: 0; }
.complete-hero p { margin: 0; color: #a0a0b2; font-size: 0.85rem; }
.url-input-group .input { min-width: 0; }
.commit-link { margin-top: 15px; font-size: 0.82rem; text-align: center; }
.commit-link a { color: #76b8f7; text-decoration: none; }
.btn-danger { color: #fca5a5; border-color: #693034; }

@media (max-width: 680px) {
    .hf-modal-backdrop { align-items: stretch; padding: 0; }
    .hf-modal { max-height: 100dvh; border: 0; border-radius: 0; }
    .hf-body { padding: 16px; }
    .field-grid { grid-template-columns: 1fr; }
    .dash-meta, .hash-row { flex-direction: column; gap: 6px; }
    .table-header, .table-row { grid-template-columns: minmax(0, 1fr) 76px 106px; padding-inline: 9px; }
    .col-status { align-items: flex-start; flex-direction: column; }
    .resume-banner { align-items: flex-start; }
    .upload-actions { flex-wrap: wrap; justify-content: flex-end; }
}
</style>
