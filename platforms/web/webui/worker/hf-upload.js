// Hugging Face LFS 协商、校验与 Commit API。
// 大文件字节流直接从浏览器发往 HF 返回的预签名地址，Worker 只保管 HF_TOKEN
// 并负责调用固定的 huggingface.co API，避免大文件经过 Worker 请求体。

import { json, error } from './headers.js';

export const HF_LFS_BATCH_LIMIT = 100;
export const HF_COMMIT_OPERATION_LIMIT = 10000;
export const HF_MULTIPART_PART_LIMIT = 10000;

const HF_COMPLETION_TIMEOUT_MS = 25000;

const SHA256_RE = /^[a-f0-9]{64}$/;
const REPO_PART_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,95})$/;
const BRANCH_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,199})$/;

class InputError extends Error {}

function getHfToken(env) {
    return env.HF_TOKEN || '';
}

function defaultRepo(env) {
    return `${env.HF_DEFAULT_OWNER || 'clown145'}/${env.HF_DEFAULT_REPO || 'gal'}`;
}

export function normalizeHfRepo(value, fallback = '') {
    const repo = String(value || fallback).trim();
    const parts = repo.split('/');
    if (parts.length !== 2 || !parts.every((part) => REPO_PART_RE.test(part))) {
        throw new InputError('repo 必须是 owner/name 格式');
    }
    return repo;
}

export function normalizeHfPath(value) {
    const rawPath = String(value || '').replace(/\\/g, '/');
    const path = rawPath.trim();
    const segments = path.split('/');
    if (path !== rawPath || !path || path.length > 1024 || path.startsWith('/') || path.endsWith('/') ||
        /[\u0000-\u001f\u007f]/.test(path) ||
        segments.some((segment) => !segment || segment === '.' || segment === '..')) {
        throw new InputError('文件路径无效');
    }
    return path;
}

export function normalizeOid(value) {
    const oid = String(value || '').toLowerCase().trim();
    if (!SHA256_RE.test(oid)) throw new InputError('sha256/oid 必须是 64 位十六进制字符串');
    return oid;
}

export function normalizeFileSize(value) {
    const size = Number(value);
    if (!Number.isSafeInteger(size) || size < 0) throw new InputError('size 必须是非负安全整数');
    return size;
}

function normalizeBranch(value) {
    const branch = String(value || 'main').trim();
    if (!BRANCH_RE.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('/')) {
        throw new InputError('branch 格式无效');
    }
    return branch;
}

function normalizeText(value, fallback, maxLength, field) {
    const text = String(value || fallback).trim();
    if (!text || text.length > maxLength) throw new InputError(`${field} 长度无效`);
    return text;
}

function parseAmzDate(value) {
    const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value || '');
    if (!match) return 0;
    return Date.UTC(
        Number(match[1]), Number(match[2]) - 1, Number(match[3]),
        Number(match[4]), Number(match[5]), Number(match[6])
    );
}

export function signedUrlExpiry(value) {
    try {
        const url = new URL(value);
        const cloudfrontExpiry = Number(url.searchParams.get('Expires')) * 1000;
        if (Number.isFinite(cloudfrontExpiry) && cloudfrontExpiry > 0) return cloudfrontExpiry;

        const hubExpiry = Date.parse(url.searchParams.get('expiration') || '');
        if (Number.isFinite(hubExpiry) && hubExpiry > 0) return hubExpiry;

        const signedAt = parseAmzDate(url.searchParams.get('X-Amz-Date'));
        const lifetime = Number(url.searchParams.get('X-Amz-Expires')) * 1000;
        if (signedAt > 0 && Number.isFinite(lifetime) && lifetime > 0) return signedAt + lifetime;
    } catch {
        return 0;
    }
    return 0;
}

function safeHttpsUrl(value) {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.username || url.password) {
        throw new InputError('Hugging Face 返回了无效的上传地址');
    }
    return url.href;
}

function safeMultipartCompletionUrl(value) {
    let url;
    try {
        url = new URL(String(value || ''));
    } catch {
        throw new InputError('Hugging Face multipart 完成地址无效');
    }

    const requiredParams = ['uploadId', 'bucket', 'prefix', 'expiration', 'signature'];
    if (url.origin !== 'https://huggingface.co' || url.pathname !== '/api/complete_multipart' ||
        url.username || url.password || url.hash || url.href.length > 8192 ||
        requiredParams.some((name) => !url.searchParams.get(name))) {
        throw new InputError('Hugging Face multipart 完成地址无效');
    }
    return url.href;
}

/**
 * 只向浏览器返回完成上传所必需的预签名字段。HF action.header 中的其他头不透传。
 */
export function sanitizeUploadAction(action, expectedSize) {
    if (!action || typeof action !== 'object') return null;

    const header = action.header && typeof action.header === 'object' ? action.header : {};
    const rawChunkSize = header.chunk_size;

    if (rawChunkSize !== undefined && rawChunkSize !== null && rawChunkSize !== '') {
        const href = safeMultipartCompletionUrl(action.href);
        const chunkSize = Number(rawChunkSize);
        if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
            throw new InputError('Hugging Face multipart chunk_size 无效');
        }

        const parts = Object.entries(header)
            .filter(([key]) => /^\d+$/.test(key))
            .map(([key, url]) => ({ partNumber: Number(key), url: safeHttpsUrl(url) }))
            .sort((a, b) => a.partNumber - b.partNumber);
        const expectedParts = Math.ceil(expectedSize / chunkSize);

        if (parts.length !== expectedParts || parts.some((part, index) => part.partNumber !== index + 1)) {
            throw new InputError('Hugging Face multipart 分片列表不完整');
        }

        const expiries = [href, ...parts.map((part) => part.url)]
            .map(signedUrlExpiry)
            .filter((expiry) => expiry > 0);

        return {
            type: 'multipart',
            href,
            chunkSize,
            parts,
            expiresAt: expiries.length ? Math.min(...expiries) : 0
        };
    }

    const href = safeHttpsUrl(action.href);
    return {
        type: 'basic',
        href,
        expiresAt: signedUrlExpiry(href)
    };
}

export function mapLfsBatchObjects(files, returnedObjects) {
    const byOid = new Map();
    for (const object of Array.isArray(returnedObjects) ? returnedObjects : []) {
        if (object && typeof object.oid === 'string') byOid.set(object.oid.toLowerCase(), object);
    }

    return files.map((file) => {
        const returned = byOid.get(file.sha256);
        if (!returned) {
            return {
                ...file,
                exists: false,
                upload: null,
                verify: false,
                error: { code: 502, message: 'Hugging Face Batch 响应缺少该对象' }
            };
        }

        if (returned.error) {
            return {
                ...file,
                exists: false,
                upload: null,
                verify: false,
                error: {
                    code: Number(returned.error.code) || 502,
                    message: String(returned.error.message || 'Hugging Face 拒绝了该 LFS 对象')
                }
            };
        }

        if (returned.size !== undefined && Number(returned.size) !== file.size) {
            return {
                ...file,
                exists: false,
                upload: null,
                verify: false,
                error: { code: 502, message: 'Hugging Face Batch 返回的对象大小不一致' }
            };
        }

        try {
            const upload = sanitizeUploadAction(returned.actions?.upload, file.size);
            return {
                ...file,
                exists: !upload,
                upload,
                verify: !!returned.actions?.verify,
                error: null
            };
        } catch (err) {
            return {
                ...file,
                exists: false,
                upload: null,
                verify: false,
                error: { code: 502, message: err.message || 'Hugging Face 上传凭证无效' }
            };
        }
    });
}

function normalizePrepareFiles(rawFiles) {
    if (!Array.isArray(rawFiles) || rawFiles.length === 0) throw new InputError('files 列表不能为空');
    if (rawFiles.length > HF_LFS_BATCH_LIMIT) {
        throw new InputError(`单次最多准备 ${HF_LFS_BATCH_LIMIT} 个文件`);
    }

    const sizesByOid = new Map();
    return rawFiles.map((file) => {
        const normalized = {
            path: normalizeHfPath(file?.path),
            sha256: normalizeOid(file?.sha256),
            size: normalizeFileSize(file?.size)
        };
        const knownSize = sizesByOid.get(normalized.sha256);
        if (knownSize !== undefined && knownSize !== normalized.size) {
            throw new InputError('相同 sha256 的文件大小不一致');
        }
        sizesByOid.set(normalized.sha256, normalized.size);
        return normalized;
    });
}

async function readJson(request) {
    try {
        return await request.json();
    } catch {
        throw new InputError('Invalid JSON body');
    }
}

function normalizeMultipartCompletion(body) {
    const href = safeMultipartCompletionUrl(body?.href);
    const oid = normalizeOid(body?.oid);
    const rawParts = body?.parts;
    if (!Array.isArray(rawParts) || rawParts.length === 0 || rawParts.length > HF_MULTIPART_PART_LIMIT) {
        throw new InputError(`multipart parts 数量必须在 1 到 ${HF_MULTIPART_PART_LIMIT} 之间`);
    }

    const parts = rawParts.map((part) => {
        const partNumber = Number(part?.partNumber);
        const etag = typeof part?.etag === 'string' ? part.etag : '';
        if (!Number.isSafeInteger(partNumber) || partNumber <= 0 ||
            !etag || etag.length > 512 || /[\u0000-\u001f\u007f]/.test(etag)) {
            throw new InputError('multipart partNumber/etag 无效');
        }
        return { partNumber, etag };
    }).sort((a, b) => a.partNumber - b.partNumber);

    if (parts.some((part, index) => part.partNumber !== index + 1)) {
        throw new InputError('multipart parts 必须从 1 开始连续排列');
    }
    return { href, oid, parts };
}

function upstreamMessage(response, text, operation) {
    const detail = String(text || '').slice(0, 2000);
    return `${operation} (${response.status})${detail ? `: ${detail}` : ''}`;
}

async function handlePrepareUpload(request, env) {
    const token = getHfToken(env);
    if (!token) {
        return error(503, '服务端未配置 HF_TOKEN，无法上传到 Hugging Face');
    }

    let body;
    let repo;
    let files;
    try {
        body = await readJson(request);
        repo = normalizeHfRepo(body?.repo, defaultRepo(env));
        files = normalizePrepareFiles(body?.files);
    } catch (err) {
        if (err instanceof InputError) return error(400, err.message);
        throw err;
    }

    const lfsBatchUrl = `https://huggingface.co/datasets/${repo}.git/info/lfs/objects/batch`;
    const payload = {
        operation: 'upload',
        transfers: ['basic', 'multipart'],
        hash_algo: 'sha256',
        objects: files.map((file) => ({ oid: file.sha256, size: file.size }))
    };

    let hfRes;
    try {
        hfRes = await fetch(lfsBatchUrl, {
            method: 'POST',
            headers: {
                'Accept': 'application/vnd.git-lfs+json',
                'Content-Type': 'application/vnd.git-lfs+json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(payload)
        });
    } catch (err) {
        return error(502, `连接 Hugging Face LFS API 失败: ${err.message}`);
    }

    if (!hfRes.ok) {
        return error(hfRes.status, upstreamMessage(hfRes, await hfRes.text(), 'Hugging Face LFS Batch 失败'));
    }

    let result;
    try {
        result = await hfRes.json();
    } catch {
        return error(502, 'Hugging Face LFS Batch 返回了无效 JSON');
    }

    return json({
        ok: true,
        repo,
        requestId: hfRes.headers.get('X-Request-Id') || '',
        objects: mapLfsBatchObjects(files, result.objects)
    });
}

async function handleCompleteMultipart(request) {
    let completion;
    try {
        completion = normalizeMultipartCompletion(await readJson(request));
    } catch (err) {
        if (err instanceof InputError) return error(400, err.message);
        throw err;
    }

    let hfRes;
    try {
        hfRes = await fetch(completion.href, {
            method: 'POST',
            headers: {
                'Accept': 'application/vnd.git-lfs+json',
                'Content-Type': 'application/vnd.git-lfs+json'
            },
            body: JSON.stringify({ oid: completion.oid, parts: completion.parts }),
            signal: AbortSignal.timeout(HF_COMPLETION_TIMEOUT_MS)
        });
    } catch (err) {
        return error(502, `LFS multipart 合并请求失败: ${err.message}`);
    }

    if (!hfRes.ok) {
        return error(hfRes.status, upstreamMessage(hfRes, await hfRes.text(), 'LFS multipart 合并失败'));
    }
    return json({ ok: true });
}

async function handleVerifyUpload(request, env) {
    const token = getHfToken(env);
    if (!token) return error(503, '服务端未配置 HF_TOKEN');

    let body;
    let repo;
    let oid;
    let size;
    try {
        body = await readJson(request);
        repo = normalizeHfRepo(body?.repo, defaultRepo(env));
        oid = normalizeOid(body?.oid);
        size = normalizeFileSize(body?.size);
    } catch (err) {
        if (err instanceof InputError) return error(400, err.message);
        throw err;
    }

    const verifyUrl = `https://huggingface.co/datasets/${repo}.git/info/lfs/objects/verify`;
    let hfRes;
    try {
        hfRes = await fetch(verifyUrl, {
            method: 'POST',
            headers: {
                'Accept': 'application/vnd.git-lfs+json',
                'Content-Type': 'application/vnd.git-lfs+json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ oid, size })
        });
    } catch (err) {
        return error(502, `LFS Verify 请求失败: ${err.message}`);
    }

    if (!hfRes.ok) {
        return error(hfRes.status, upstreamMessage(hfRes, await hfRes.text(), 'LFS Verify 失败'));
    }
    return json({ ok: true });
}

function normalizeCommitOperations(rawOperations) {
    if (!Array.isArray(rawOperations) || rawOperations.length === 0) {
        throw new InputError('operations 列表不能为空');
    }
    if (rawOperations.length > HF_COMMIT_OPERATION_LIMIT) {
        throw new InputError(`单次 Commit 最多 ${HF_COMMIT_OPERATION_LIMIT} 个操作`);
    }

    return rawOperations.map((operation) => {
        const key = operation?.operation || operation?.key;
        const value = operation?.value || operation || {};
        const path = normalizeHfPath(operation?.path || value.path);

        if (key === 'lfsFile') {
            return {
                key,
                value: {
                    path,
                    algo: 'sha256',
                    oid: normalizeOid(operation?.oid || operation?.content || value.oid),
                    size: normalizeFileSize(operation?.size ?? value.size)
                }
            };
        }

        if (key === 'file') {
            const content = operation?.content ?? value.content;
            const encoding = operation?.encoding || value.encoding || 'base64';
            if (typeof content !== 'string' || !['base64', 'utf-8'].includes(encoding)) {
                throw new InputError(`普通文件 ${path} 的 content/encoding 无效`);
            }
            return { key, value: { path, content, encoding } };
        }

        if (key === 'deletedFile' || key === 'deletedFolder') {
            return { key, value: { path } };
        }

        throw new InputError(`不支持的 Commit 操作: ${String(key || '')}`);
    });
}

export function buildCommitNdjson({ summary, description, operations }) {
    return [
        JSON.stringify({ key: 'header', value: { summary, description } }),
        ...operations.map((operation) => JSON.stringify(operation))
    ].join('\n') + '\n';
}

async function handleCommit(request, env) {
    const token = getHfToken(env);
    if (!token) return error(503, '服务端未配置 HF_TOKEN');

    let body;
    let repo;
    let branch;
    let summary;
    let description;
    let operations;
    try {
        body = await readJson(request);
        repo = normalizeHfRepo(body?.repo, defaultRepo(env));
        branch = normalizeBranch(body?.branch || 'main');
        summary = normalizeText(body?.summary, 'Upload game assets via WebUI', 512, 'summary');
        description = String(body?.description || '').trim().slice(0, 10000);
        operations = normalizeCommitOperations(body?.operations);
    } catch (err) {
        if (err instanceof InputError) return error(400, err.message);
        throw err;
    }

    const ndjsonBody = buildCommitNdjson({ summary, description, operations });
    const commitUrl = `https://huggingface.co/api/datasets/${repo}/commit/${encodeURIComponent(branch)}`;

    let hfRes;
    try {
        hfRes = await fetch(commitUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/x-ndjson'
            },
            body: ndjsonBody
        });
    } catch (err) {
        return error(502, `连接 Hugging Face Commit API 失败: ${err.message}`);
    }

    if (!hfRes.ok) {
        return error(hfRes.status, upstreamMessage(hfRes, await hfRes.text(), 'Hugging Face Commit 失败'));
    }

    let result;
    try {
        result = await hfRes.json();
    } catch {
        return error(502, 'Hugging Face Commit 返回了无效 JSON');
    }
    return json({
        ok: true,
        repo,
        commitUrl: result.commitUrl || `https://huggingface.co/datasets/${repo}/commit/${result.commitOid || branch}`,
        commitOid: result.commitOid || ''
    });
}

export async function handleHfUploadApi(request, env, ctx, segments) {
    const [action] = segments;
    if (action === 'prepare-upload' && request.method === 'POST') return handlePrepareUpload(request, env);
    if (action === 'complete-multipart' && request.method === 'POST') return handleCompleteMultipart(request);
    if (action === 'verify-upload' && request.method === 'POST') return handleVerifyUpload(request, env);
    if (action === 'commit' && request.method === 'POST') return handleCommit(request, env);
    return error(404, 'Unknown HF upload endpoint');
}
