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
 * 提交 Git Commit。
 *
 * 输入格式：
 * {
 *   repo: "clown145/gal",
 *   branch: "main",
 *   summary: "Upload 水葬银货 (shuizangyinhuo)",
 *   operations: [
 *     { operation: "lfsFile", path: "shuizangyinhuo/data.xp3", content: "<sha256>", size: 123456 },
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
    const operations = Array.isArray(body?.operations) ? body.operations : [];

    if (!operations.length) {
        return error(400, 'operations 列表不能为空');
    }

    const commitUrl = `https://huggingface.co/api/datasets/${repo}/commit/${branch}`;
    const payload = {
        summary: summary,
        operations: operations
    };

    let hfRes;
    try {
        hfRes = await fetch(commitUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
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

    if (action === 'commit' && request.method === 'POST') {
        return handleCommit(request, env);
    }

    return error(404, 'Unknown HF upload endpoint');
}
