// Hugging Face 仓库上传与提交 API 协调器。
//
// 提供给后台管理员界面的安全上传能力：
// 1. /api/admin/hf/prepare-upload: 调用 LFS Batch API 进行秒传检测与获取 S3 预签名上传凭证。
// 2. /api/admin/hf/commit: 调用 Commit API 原子提交所有已上传的 LFS 文件与普通文件（如 manifest.json）。

import { json, error } from './headers.js';
import { isAuthed } from './auth.js';

function getHfToken(env) {
    return env.HF_TOKEN || '';
}

/**
 * 协商 LFS 批量上传。
 *
 * 输入格式：
 * {
 *   repo: "clown145/gal",
 *   files: [
 *     { path: "shuizangyinhuo/data.xp3", size: 123456, sha256: "abc..." }
 *   ]
 * }
 */
async function handlePrepareUpload(request, env) {
    const token = getHfToken(env);
    if (!token) {
        return error(503, '服务端未配置 HF_TOKEN，无法上传到 Hugging Face。请在 Cloudflare Worker 中配置 Secret: HF_TOKEN');
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return error(400, 'Invalid JSON body');
    }

    const defaultOwner = env.HF_DEFAULT_OWNER || 'clown145';
    const defaultRepo = env.HF_DEFAULT_REPO || 'gal';
    const repo = (body?.repo || `${defaultOwner}/${defaultRepo}`).trim();
    const files = Array.isArray(body?.files) ? body.files : [];

    if (!files.length) {
        return error(400, 'files 列表不能为空');
    }

    // 格式化 objects
    const objects = files.map((f) => ({
        oid: String(f.sha256).toLowerCase().trim(),
        size: Number(f.size)
    }));

    const lfsBatchUrl = `https://huggingface.co/datasets/${repo}.git/info/lfs/objects/batch`;
    const payload = {
        operation: 'upload',
        transfers: ['basic'],
        objects: objects
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
        return error(502, '连接 Hugging Face LFS API 失败: ' + err.message);
    }

    if (!hfRes.ok) {
        const text = await hfRes.text();
        return error(hfRes.status, `Hugging Face LFS Batch 失败 (${hfRes.status}): ${text}`);
    }

    const result = await hfRes.json();
    const returnedObjects = result.objects || [];

    // 将返回结果与原始文件路径一一关联
    const mapped = files.map((f, i) => {
        const returned = returnedObjects[i] || {};
        const isExisting = !returned.actions || !returned.actions.upload;
        return {
            path: f.path,
            sha256: f.sha256,
            size: f.size,
            exists: isExisting, // true 表示云端已存在（可秒传）
            uploadAction: returned.actions?.upload || null
        };
    });

    return json({
        ok: true,
        repo: repo,
        objects: mapped
    });
}

/**
 * 验证 LFS 对象上传完成（调用 Hugging Face Verify API）。
 */
async function handleVerifyUpload(request, env) {
    const token = getHfToken(env);
    if (!token) {
        return error(503, '服务端未配置 HF_TOKEN');
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return error(400, 'Invalid JSON body');
    }

    const defaultOwner = env.HF_DEFAULT_OWNER || 'clown145';
    const defaultRepo = env.HF_DEFAULT_REPO || 'gal';
    const repo = (body?.repo || `${defaultOwner}/${defaultRepo}`).trim();
    const oid = String(body?.oid || '').toLowerCase().trim();
    const size = Number(body?.size || 0);

    if (!oid || size <= 0) {
        return error(400, 'oid 和 size 不能为空且 size 必须大于 0');
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
        return error(502, 'LFS Verify 请求失败: ' + err.message);
    }

    if (!hfRes.ok) {
        const text = await hfRes.text();
        return error(hfRes.status, `LFS Verify 失败 (${hfRes.status}): ${text}`);
    }

    return json({ ok: true });
}

/**
 * 提交 Git Commit（采用 Hugging Face 规范的 application/x-ndjson 格式）。
 *
 * 输入格式：
 * {
 *   repo: "clown145/gal",
 *   branch: "main",
 *   summary: "Upload 水葬银货 (shuizangyinhuo)",
 *   operations: [
 *     { operation: "lfsFile", path: "shuizangyinhuo/data.xp3", oid: "<sha256>", size: 123456 },
 *     { operation: "file", path: "shuizangyinhuo/manifest.json", content: "<base64_encoded>", encoding: "base64" }
 *   ]
 * }
 */
async function handleCommit(request, env) {
    const token = getHfToken(env);
    if (!token) {
        return error(503, '服务端未配置 HF_TOKEN');
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return error(400, 'Invalid JSON body');
    }

    const defaultOwner = env.HF_DEFAULT_OWNER || 'clown145';
    const defaultRepo = env.HF_DEFAULT_REPO || 'gal';
    const repo = (body?.repo || `${defaultOwner}/${defaultRepo}`).trim();
    const branch = (body?.branch || 'main').trim();
    const summary = (body?.summary || 'Upload game assets via WebUI').trim();
    const description = (body?.description || '').trim();
    const operations = Array.isArray(body?.operations) ? body.operations : [];

    if (!operations.length) {
        return error(400, 'operations 列表不能为空');
    }

    // 将 operations 转换为 Hugging Face 规范的 NDJSON (application/x-ndjson)
    const ndjsonLines = [];

    // 1. Header 行
    ndjsonLines.push(JSON.stringify({
        key: 'header',
        value: {
            summary: summary,
            description: description
        }
    }));

    // 2. 逐个文件操作行
    for (const op of operations) {
        if (op.operation === 'lfsFile' || op.key === 'lfsFile') {
            const path = op.path || op.value?.path;
            const oid = (op.oid || op.content || op.value?.oid || '').toLowerCase().trim();
            const size = Number(op.size || op.value?.size || 0);
            ndjsonLines.push(JSON.stringify({
                key: 'lfsFile',
                value: {
                    path: path,
                    algo: 'sha256',
                    oid: oid,
                    size: size
                }
            }));
        } else if (op.operation === 'file' || op.key === 'file') {
            const path = op.path || op.value?.path;
            const content = op.content || op.value?.content;
            const encoding = op.encoding || op.value?.encoding || 'base64';
            ndjsonLines.push(JSON.stringify({
                key: 'file',
                value: {
                    path: path,
                    content: content,
                    encoding: encoding
                }
            }));
        } else if (op.operation === 'deletedFile' || op.key === 'deletedFile') {
            ndjsonLines.push(JSON.stringify({
                key: 'deletedFile',
                value: { path: op.path || op.value?.path }
            }));
        } else if (op.operation === 'deletedFolder' || op.key === 'deletedFolder') {
            ndjsonLines.push(JSON.stringify({
                key: 'deletedFolder',
                value: { path: op.path || op.value?.path }
            }));
        }
    }

    const ndjsonBody = ndjsonLines.join('\n') + '\n';
    const commitUrl = `https://huggingface.co/api/datasets/${repo}/commit/${branch}`;

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
        return error(502, '连接 Hugging Face Commit API 失败: ' + err.message);
    }

    if (!hfRes.ok) {
        const text = await hfRes.text();
        return error(hfRes.status, `Hugging Face Commit 失败 (${hfRes.status}): ${text}`);
    }

    const result = await hfRes.json();
    return json({
        ok: true,
        repo: repo,
        commitUrl: result.commitUrl || `https://huggingface.co/datasets/${repo}/commit/${result.commitOid || branch}`,
        commitOid: result.commitOid || ''
    });
}

/**
 * 后台 Hugging Face 上传路由调度。
 */
export async function handleHfUploadApi(request, env, ctx, segments) {
    const [action] = segments;

    if (action === 'prepare-upload' && request.method === 'POST') {
        return handlePrepareUpload(request, env);
    }

    if (action === 'verify-upload' && request.method === 'POST') {
        return handleVerifyUpload(request, env);
    }

    if (action === 'commit' && request.method === 'POST') {
        return handleCommit(request, env);
    }

    return error(404, 'Unknown HF upload endpoint');
}
