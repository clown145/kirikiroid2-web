<script setup>
import { ref, computed, watch, onUnmounted } from 'vue';
import { toast } from '../shared/toast.js';
import { toPinyinSlug } from '../shared/pinyin.js';

const props = defineProps({
    show: { type: Boolean, default: false }
});

const emit = defineEmits(['close', 'complete']);

// --- 状态流转: 'select' | 'uploading' | 'completed' ------------------
const step = ref('select');

const targetRepo = ref('clown145/gal');
const gameTitle = ref('');
const gameSlug = ref('');
const files = ref([]);          // [{ name, file, size, sha256, status, progress, exists, uploadAction }]
const hasExistingManifest = ref(false);
const generatedManifest = ref(null);

const uploading = ref(false);
const totalBytes = ref(0);
const uploadedBytes = ref(0);
const currentSpeed = ref('0 B/s');
const timeRemaining = ref('--');
const currentTaskMsg = ref('');
const completedCommitUrl = ref('');
const proxiedManifestUrl = ref('');

const dirInput = ref(null);
const isDragging = ref(false);

let speedTimer = null;
let lastBytes = 0;
let lastTime = Date.now();

// --- 格式化辅助 ------------------------------------------------------

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
}

const overallPercent = computed(() => {
    if (totalBytes.value === 0) return 0;
    return Math.min(100, Math.round((uploadedBytes.value / totalBytes.value) * 100));
});

// --- 选择文件夹与解析 ------------------------------------------------

async function onPickFolder() {
    if (typeof window.showDirectoryPicker === 'function') {
        try {
            const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
            await processDirectoryHandle(dirHandle);
        } catch (err) {
            if (err?.name !== 'AbortError') {
                toast.error('读取文件夹失败: ' + err.message);
            }
        }
    } else {
        dirInput.value?.click();
    }
}

async function scanHandle(dirHandle, relativePath = '') {
    let list = [];
    for await (const [name, handle] of dirHandle.entries()) {
        if (name === '.DS_Store' || name === 'Thumbs.db' || name.toLowerCase().endsWith('.exe')) {
            continue;
        }
        const itemPath = relativePath ? `${relativePath}/${name}` : name;
        if (handle.kind === 'directory') {
            list = list.concat(await scanHandle(handle, itemPath));
        } else if (handle.kind === 'file') {
            const file = await handle.getFile();
            list.push({
                name: itemPath.replace(/\\/g, '/'),
                file: file,
                size: file.size,
                status: 'pending', // 'pending' | 'hashing' | 'uploading' | 'done' | 'dedup' | 'error'
                progress: 0
            });
        }
    }
    return list;
}

async function processDirectoryHandle(dirHandle) {
    const rawTitle = dirHandle.name || 'Game';
    gameTitle.value = rawTitle;
    gameSlug.value = toPinyinSlug(rawTitle);

    toast.info('正在扫描文件...');
    const scanned = await scanHandle(dirHandle);
    setupScannedFiles(scanned);
}

function onInputFolderSelect(e) {
    const inputFiles = Array.from(e.target.files || []);
    e.target.value = '';
    if (!inputFiles.length) return;

    // 从第一个文件路径提取文件夹根名
    const firstRel = inputFiles[0].webkitRelativePath || '';
    const rootName = firstRel.split('/')[0] || 'Game';
    gameTitle.value = rootName;
    gameSlug.value = toPinyinSlug(rootName);

    const scanned = [];
    for (const f of inputFiles) {
        const name = f.name;
        if (name === '.DS_Store' || name === 'Thumbs.db' || name.toLowerCase().endsWith('.exe')) {
            continue;
        }
        const relPath = (f.webkitRelativePath || f.name).replace(/^[^/]+\//, '');
        scanned.push({
            name: relPath.replace(/\\/g, '/'),
            file: f,
            size: f.size,
            status: 'pending',
            progress: 0
        });
    }

    setupScannedFiles(scanned);
}

function setupScannedFiles(scanned) {
    if (!scanned.length) {
        toast.error('未在选择的文件夹中发现有效游戏资源');
        return;
    }

    const manifestEntry = scanned.find((f) => f.name.toLowerCase() === 'manifest.json');
    hasExistingManifest.value = !!manifestEntry;

    files.value = scanned;
    totalBytes.value = scanned.reduce((acc, f) => acc + f.size, 0);
    step.value = 'select';
}

function onDrop(e) {
    isDragging.value = false;
    // 降级支持
    const items = e.dataTransfer?.items;
    if (items && items.length) {
        toast.info('请点击“选择本地游戏文件夹”以获得完整目录结构');
    }
}

// --- 计算文件 SHA256 -------------------------------------------------

async function computeSha256(file) {
    const buffer = await file.arrayBuffer();
    const hashBuf = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(hashBuf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

// --- 上传逻辑 --------------------------------------------------------

function uploadToS3(uploadAction, file, onProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', uploadAction.href);
        if (uploadAction.header) {
            for (const [k, v] of Object.entries(uploadAction.header)) {
                xhr.setRequestHeader(k, v);
            }
        }
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && onProgress) {
                onProgress(e.loaded, e.total);
            }
        };
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve();
            } else {
                reject(new Error(`S3 上传失败 (${xhr.status}): ${xhr.responseText || xhr.statusText}`));
            }
        };
        xhr.onerror = () => reject(new Error('网络中断，上传失败'));
        xhr.send(file);
    });
}

function startSpeedMonitor() {
    lastBytes = 0;
    lastTime = Date.now();
    speedTimer = setInterval(() => {
        const now = Date.now();
        const timeDiff = (now - lastTime) / 1000;
        if (timeDiff > 0.5) {
            const bytesDiff = uploadedBytes.value - lastBytes;
            const speed = bytesDiff / timeDiff;
            currentSpeed.value = formatBytes(speed) + '/s';

            const remainBytes = totalBytes.value - uploadedBytes.value;
            if (speed > 0 && remainBytes > 0) {
                const remainSec = Math.round(remainBytes / speed);
                if (remainSec > 60) {
                    timeRemaining.value = `${Math.floor(remainSec / 60)} 分 ${remainSec % 60} 秒`;
                } else {
                    timeRemaining.value = `${remainSec} 秒`;
                }
            } else {
                timeRemaining.value = '--';
            }

            lastBytes = uploadedBytes.value;
            lastTime = now;
        }
    }, 800);
}

function stopSpeedMonitor() {
    if (speedTimer) {
        clearInterval(speedTimer);
        speedTimer = null;
    }
}

async function startUpload() {
    if (!files.value.length) return;
    const slug = gameSlug.value.trim();
    if (!slug) {
        toast.error('目标拼音目录名不能为空');
        return;
    }

    step.value = 'uploading';
    uploading.value = true;
    uploadedBytes.value = 0;
    startSpeedMonitor();

    try {
        // 1. 准备/自动生成 manifest.json
        let manifestData = [];
        const nonManifestFiles = files.value.filter((f) => f.name.toLowerCase() !== 'manifest.json');
        
        for (const item of nonManifestFiles) {
            manifestData.push({
                name: item.name,
                size: item.size
            });
        }

        const manifestJsonStr = JSON.stringify(manifestData, null, 2);

        // 2. 计算每个实体文件的 SHA-256
        currentTaskMsg.value = '正在计算文件指纹与哈希 (SHA-256)...';
        for (let i = 0; i < nonManifestFiles.length; i++) {
            const item = nonManifestFiles[i];
            item.status = 'hashing';
            currentTaskMsg.value = `正在校验指纹 (${i + 1}/${nonManifestFiles.length}): ${item.name}`;
            item.sha256 = await computeSha256(item.file);
            item.status = 'pending';
        }

        // 3. 向 Worker 请求 LFS 预签名与秒传检测
        currentTaskMsg.value = '正在向 Hugging Face 申请 LFS 上传通道与秒传校验...';
        const prepRes = await fetch('/api/admin/hf/prepare-upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                repo: targetRepo.value.trim(),
                files: nonManifestFiles.map((f) => ({
                    path: `${slug}/${f.name}`,
                    size: f.size,
                    sha256: f.sha256
                }))
            })
        });

        if (!prepRes.ok) {
            const errData = await prepRes.json().catch(() => ({}));
            throw new Error(errData.error || `LFS 准备失败 (${prepRes.status})`);
        }

        const prepResult = await prepRes.json();
        const objects = prepResult.objects || [];

        // 4. 执行文件上传（支持秒传和并发进度）
        currentTaskMsg.value = '正在传输文件到 Hugging Face 存储...';

        const fileBytesTracker = new Map();

        for (let i = 0; i < nonManifestFiles.length; i++) {
            const item = nonManifestFiles[i];
            const meta = objects[i];

            if (meta && meta.exists) {
                // 秒传
                item.status = 'dedup';
                item.progress = 100;
                uploadedBytes.value += item.size;
                continue;
            }

            if (!meta || !meta.uploadAction) {
                throw new Error(`无法获取文件 ${item.name} 的上传凭证`);
            }

            item.status = 'uploading';
            currentTaskMsg.value = `正在上传 (${i + 1}/${nonManifestFiles.length}): ${item.name}`;

            fileBytesTracker.set(item.name, 0);

            await uploadToS3(meta.uploadAction, item.file, (loaded) => {
                const prev = fileBytesTracker.get(item.name) || 0;
                const diff = loaded - prev;
                fileBytesTracker.set(item.name, loaded);
                uploadedBytes.value += diff;
                item.progress = Math.round((loaded / item.size) * 100);
            });

            // 告知 Hugging Face 校验已上传的 S3 对象
            const verifyRes = await fetch('/api/admin/hf/verify-upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    repo: targetRepo.value.trim(),
                    oid: item.sha256,
                    size: item.size
                })
            });

            if (!verifyRes.ok) {
                const errData = await verifyRes.json().catch(() => ({}));
                throw new Error(errData.error || `LFS 校验失败 (${verifyRes.status})`);
            }

            item.status = 'done';
            item.progress = 100;
        }

        // 5. 提交 Git Commit
        currentTaskMsg.value = '文件上传完毕，正在 Hugging Face 创建原子 Commit...';

        const operations = [
            // 所有的 LFS 文件
            ...nonManifestFiles.map((f) => ({
                operation: 'lfsFile',
                path: `${slug}/${f.name}`,
                oid: f.sha256,
                size: f.size
            })),
            // manifest.json 以普通文件提交
            {
                operation: 'file',
                path: `${slug}/manifest.json`,
                content: btoa(unescape(encodeURIComponent(manifestJsonStr))),
                encoding: 'base64'
            }
        ];

        const commitRes = await fetch('/api/admin/hf/commit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                repo: targetRepo.value.trim(),
                branch: 'main',
                summary: `Upload ${gameTitle.value} (${slug}) via WebUI`,
                operations: operations
            })
        });

        if (!commitRes.ok) {
            const errData = await commitRes.json().catch(() => ({}));
            throw new Error(errData.error || `Commit 失败 (${commitRes.status})`);
        }

        const commitResult = await commitRes.json();
        completedCommitUrl.value = commitResult.commitUrl;

        // 生成代理加速后的 Manifest URL
        const repoName = targetRepo.value.split('/')[1] || 'gal';
        proxiedManifestUrl.value = `${window.location.origin}/hf/${repoName}/${slug}/manifest.json`;

        stopSpeedMonitor();
        step.value = 'completed';
        toast.success('🎉 上传成功并已完成 Commit 提交！');
    } catch (err) {
        stopSpeedMonitor();
        toast.error('上传失败: ' + err.message);
        currentTaskMsg.value = '❌ 上传中断: ' + err.message;
    } finally {
        uploading.value = false;
    }
}

function copyUrl() {
    if (proxiedManifestUrl.value) {
        navigator.clipboard.writeText(proxiedManifestUrl.value);
        toast.success('已复制代理清单链接！');
    }
}

function handleCreateGameDirectly() {
    // 自动寻找 entryXp3 (如 data.xp3 或第一个 xp3)
    let detectedEntry = '';
    const xp3Files = files.value.filter((f) => f.name.toLowerCase().endsWith('.xp3'));
    if (xp3Files.some((f) => f.name.toLowerCase() === 'data.xp3')) {
        detectedEntry = 'data.xp3';
    } else if (xp3Files.length) {
        detectedEntry = xp3Files[0].name;
    }

    emit('complete', {
        title: gameTitle.value,
        downloadUrl: proxiedManifestUrl.value,
        entryXp3: detectedEntry
    });
    emit('close');
}

function reset() {
    step.value = 'select';
    files.value = [];
    totalBytes.value = 0;
    uploadedBytes.value = 0;
    uploading.value = false;
    stopSpeedMonitor();
}

watch(() => props.show, (val) => {
    if (val) reset();
});

onUnmounted(() => {
    stopSpeedMonitor();
});
</script>

<template>
    <div v-if="show" class="hf-modal-backdrop" @click.self="!uploading && emit('close')">
        <div class="hf-modal">
            <header class="hf-head">
                <div class="hf-head-title">
                    <span class="hf-logo">🤗</span>
                    <h2>上传游戏到 Hugging Face 仓库</h2>
                </div>
                <button v-if="!uploading" class="btn btn-ghost btn-sm" @click="emit('close')">✕</button>
            </header>

            <div class="hf-body">
                <!-- 步骤 1: 选择文件夹 & 确认配置 -->
                <div v-if="step === 'select'" class="step-select">
                    <div
                        class="dropzone"
                        :class="{ active: isDragging }"
                        @dragover.prevent="isDragging = true"
                        @dragleave.prevent="isDragging = false"
                        @drop.prevent="onDrop"
                        @click="onPickFolder">
                        <div class="drop-icon">📁</div>
                        <h3>{{ files.length ? `已选择：${gameTitle} (${files.length} 个文件)` : '点击选择游戏文件夹' }}</h3>
                        <p class="drop-hint">
                            {{ files.length ? `总大小 ${formatBytes(totalBytes)}，点击可更换文件夹` : '支持全套 .xp3 / 音视频资源与 manifest.json 自动识别' }}
                        </p>
                        <input
                            ref="dirInput"
                            type="file"
                            webkitdirectory
                            directory
                            multiple
                            hidden
                            @change="onInputFolderSelect">
                    </div>

                    <div v-if="files.length" class="config-card">
                        <div class="field-row">
                            <div class="field-item">
                                <label>游戏名称</label>
                                <input v-model="gameTitle" class="input" placeholder="水葬银货">
                            </div>
                            <div class="field-item">
                                <label>目标拼音目录 (URL 路径)</label>
                                <input v-model="gameSlug" class="input" placeholder="shuizangyinhuo">
                            </div>
                        </div>

                        <div class="field-row">
                            <div class="field-item">
                                <label>目标 Hugging Face 仓库</label>
                                <input v-model="targetRepo" class="input" placeholder="clown145/gal">
                            </div>
                            <div class="field-item">
                                <label>清单状态</label>
                                <div class="manifest-status-badge" :class="{ ok: hasExistingManifest }">
                                    {{ hasExistingManifest ? '✅ 检测到已有 manifest.json' : '⚡ 缺失 manifest.json，将自动生成' }}
                                </div>
                            </div>
                        </div>

                        <div class="files-preview">
                            <div class="preview-head">
                                <span>待上传文件列表 (共 {{ files.length }} 个)</span>
                                <span>{{ formatBytes(totalBytes) }}</span>
                            </div>
                            <div class="preview-list">
                                <div v-for="f in files.slice(0, 8)" :key="f.name" class="preview-item">
                                    <span class="file-name">{{ f.name }}</span>
                                    <span class="file-size">{{ formatBytes(f.size) }}</span>
                                </div>
                                <div v-if="files.length > 8" class="preview-more">
                                    ... 以及另外 {{ files.length - 8 }} 个文件
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 步骤 2: 正在上传 (动态大进度条 + 速度 + 单文件状态) -->
                <div v-else-if="step === 'uploading'" class="step-uploading">
                    <div class="progress-dashboard">
                        <div class="dash-top">
                            <span class="dash-title">{{ currentTaskMsg }}</span>
                            <span class="dash-pct">{{ overallPercent }}%</span>
                        </div>
                        <div class="bar-bg">
                            <div class="bar-fill" :style="{ width: overallPercent + '%' }" />
                        </div>
                        <div class="dash-meta">
                            <span>📦 已传输：{{ formatBytes(uploadedBytes) }} / {{ formatBytes(totalBytes) }}</span>
                            <span>⚡ 上传速度：{{ currentSpeed }}</span>
                            <span>⏱️ 预估剩余：{{ timeRemaining }}</span>
                        </div>
                    </div>

                    <div class="upload-files-table">
                        <div class="table-header">
                            <span class="col-file">文件路径</span>
                            <span class="col-size">大小</span>
                            <span class="col-status">状态 / 进度</span>
                        </div>
                        <div class="table-body">
                            <div v-for="f in files" :key="f.name" class="table-row">
                                <span class="col-file" :title="f.name">{{ f.name }}</span>
                                <span class="col-size">{{ formatBytes(f.size) }}</span>
                                <span class="col-status">
                                    <span v-if="f.status === 'pending'" class="badge badge-pending">⏳ 等待中</span>
                                    <span v-else-if="f.status === 'hashing'" class="badge badge-hash">🔍 校验哈希</span>
                                    <span v-else-if="f.status === 'uploading'" class="badge badge-uploading">⚡ {{ f.progress }}%</span>
                                    <span v-else-if="f.status === 'dedup'" class="badge badge-dedup">✨ 秒传 (云端已有)</span>
                                    <span v-else-if="f.status === 'done'" class="badge badge-done">✅ 已完成</span>
                                    <span v-else class="badge badge-err">❌ 失败</span>
                                </span>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 步骤 3: 上传完成 -->
                <div v-else-if="step === 'completed'" class="step-completed">
                    <div class="complete-hero">
                        <div class="complete-icon">🎉</div>
                        <h3>上传成功！资源已就绪</h3>
                        <p>游戏资源已同步至 Hugging Face <code>{{ targetRepo }}/{{ gameSlug }}</code> 并开启动态 CDN 加速中转。</p>
                    </div>

                    <div class="url-card">
                        <label>代理加速清单地址 (已配置 1 年专属边缘缓存隔离)：</label>
                        <div class="url-input-group">
                            <input readonly :value="proxiedManifestUrl" class="input">
                            <button class="btn btn-sm" @click="copyUrl">📋 复制</button>
                        </div>
                    </div>

                    <div v-if="completedCommitUrl" class="commit-link">
                        <a :href="completedCommitUrl" target="_blank" rel="noopener">查看 Hugging Face Commit 记录 ↗</a>
                    </div>
                </div>
            </div>

            <footer class="hf-foot">
                <div v-if="step === 'select'">
                    <button class="btn" @click="emit('close')">取消</button>
                    <button class="btn btn-primary" :disabled="!files.length" @click="startUpload">
                        🚀 开始上传到抱脸
                    </button>
                </div>
                <div v-else-if="step === 'uploading'">
                    <span class="upload-hint">正在传输中，请勿关闭或刷新此页面...</span>
                </div>
                <div v-else-if="step === 'completed'" class="complete-actions">
                    <button class="btn" @click="emit('close')">关闭</button>
                    <button class="btn btn-primary btn-lg" @click="handleCreateGameDirectly">
                        ➕ 一键创建游戏并填好表单
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
    background: rgba(0, 0, 0, 0.7);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 20px;
}

.hf-modal {
    background: #1e1e24;
    border: 1px solid #33333d;
    border-radius: 12px;
    width: 100%;
    max-width: 760px;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6);
    color: #e6e6eb;
}

.hf-head {
    padding: 18px 24px;
    border-bottom: 1px solid #2d2d38;
    display: flex;
    justify-content: space-between;
    align-items: center;
}

.hf-head-title {
    display: flex;
    align-items: center;
    gap: 12px;
}

.hf-logo {
    font-size: 24px;
}

.hf-head h2 {
    margin: 0;
    font-size: 1.15rem;
    font-weight: 600;
}

.hf-body {
    padding: 24px;
    overflow-y: auto;
    flex: 1;
}

.dropzone {
    border: 2px dashed #40404f;
    border-radius: 10px;
    padding: 32px;
    text-align: center;
    cursor: pointer;
    background: #18181f;
    transition: all 0.2s ease;
}

.dropzone:hover, .dropzone.active {
    border-color: #ffd21e;
    background: #23232c;
}

.drop-icon {
    font-size: 40px;
    margin-bottom: 12px;
}

.dropzone h3 {
    margin: 0 0 6px;
    font-size: 1.05rem;
}

.drop-hint {
    margin: 0;
    font-size: 0.85rem;
    color: #9494a0;
}

.config-card {
    margin-top: 20px;
    background: #15151c;
    border: 1px solid #2d2d38;
    border-radius: 8px;
    padding: 16px;
}

.field-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    margin-bottom: 14px;
}

.field-item label {
    display: block;
    font-size: 0.8rem;
    color: #a0a0b0;
    margin-bottom: 6px;
}

.manifest-status-badge {
    height: 38px;
    display: flex;
    align-items: center;
    padding: 0 12px;
    border-radius: 6px;
    background: #2a2312;
    border: 1px solid #735314;
    color: #ffd21e;
    font-size: 0.85rem;
}

.manifest-status-badge.ok {
    background: #13281c;
    border-color: #216a3a;
    color: #4ade80;
}

.files-preview {
    margin-top: 14px;
    background: #1a1a24;
    border-radius: 6px;
    padding: 12px;
    font-size: 0.85rem;
}

.preview-head {
    display: flex;
    justify-content: space-between;
    font-weight: 600;
    padding-bottom: 8px;
    border-bottom: 1px solid #2a2a38;
    color: #b0b0c0;
}

.preview-list {
    margin-top: 8px;
    max-height: 160px;
    overflow-y: auto;
}

.preview-item {
    display: flex;
    justify-content: space-between;
    padding: 4px 0;
    color: #888899;
}

.preview-more {
    text-align: center;
    color: #777788;
    margin-top: 6px;
    font-style: italic;
}

/* 进度仪表板 */
.progress-dashboard {
    background: #15151c;
    border: 1px solid #2d2d38;
    border-radius: 10px;
    padding: 20px;
    margin-bottom: 20px;
}

.dash-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
}

.dash-title {
    font-size: 0.95rem;
    font-weight: 500;
    color: #ffd21e;
}

.dash-pct {
    font-size: 1.4rem;
    font-weight: 700;
    color: #ffffff;
}

.bar-bg {
    height: 12px;
    background: #2a2a38;
    border-radius: 6px;
    overflow: hidden;
    margin-bottom: 12px;
}

.bar-fill {
    height: 100%;
    background: linear-gradient(90deg, #ffd21e, #ff9900);
    transition: width 0.2s ease;
}

.dash-meta {
    display: flex;
    justify-content: space-between;
    font-size: 0.85rem;
    color: #a0a0b2;
}

.upload-files-table {
    border: 1px solid #2d2d38;
    border-radius: 8px;
    overflow: hidden;
    font-size: 0.85rem;
}

.table-header {
    display: grid;
    grid-template-columns: 1fr 100px 140px;
    background: #16161f;
    padding: 10px 14px;
    font-weight: 600;
    border-bottom: 1px solid #2d2d38;
    color: #9c9cae;
}

.table-body {
    max-height: 240px;
    overflow-y: auto;
    background: #1b1b24;
}

.table-row {
    display: grid;
    grid-template-columns: 1fr 100px 140px;
    padding: 8px 14px;
    border-bottom: 1px solid #23232f;
    align-items: center;
}

.col-file {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.badge {
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 0.75rem;
    display: inline-block;
}

.badge-pending { background: #2c2c38; color: #a0a0b0; }
.badge-hash { background: #1c2e3d; color: #60a5fa; }
.badge-uploading { background: #382c12; color: #fbbf24; }
.badge-dedup { background: #1b332b; color: #34d399; font-weight: 600; }
.badge-done { background: #14331e; color: #4ade80; }
.badge-err { background: #3b1818; color: #f87171; }

/* 完成页 */
.complete-hero {
    text-align: center;
    padding: 20px 0;
}

.complete-icon {
    font-size: 54px;
    margin-bottom: 12px;
}

.complete-hero h3 {
    font-size: 1.3rem;
    margin: 0 0 8px;
    color: #4ade80;
}

.complete-hero p {
    color: #a0a0b2;
    margin: 0;
    font-size: 0.9rem;
}

.url-card {
    background: #15151c;
    border: 1px solid #2d2d38;
    border-radius: 8px;
    padding: 16px;
    margin: 20px 0;
}

.url-card label {
    display: block;
    font-size: 0.85rem;
    color: #a0a0b0;
    margin-bottom: 8px;
}

.url-input-group {
    display: flex;
    gap: 8px;
}

.commit-link {
    text-align: center;
    font-size: 0.85rem;
}

.commit-link a {
    color: #60a5fa;
    text-decoration: none;
}

.commit-link a:hover {
    text-decoration: underline;
}

.hf-foot {
    padding: 16px 24px;
    border-top: 1px solid #2d2d38;
    display: flex;
    justify-content: flex-end;
    background: #181820;
    border-bottom-left-radius: 12px;
    border-bottom-right-radius: 12px;
}

.hf-foot > div {
    display: flex;
    gap: 12px;
    align-items: center;
}

.upload-hint {
    color: #fbbf24;
    font-size: 0.85rem;
}

.btn-lg {
    padding: 8px 20px;
    font-size: 0.95rem;
    font-weight: 600;
}
</style>
