// Hugging Face 资源反向代理与 CDN 边缘加速中转器。
//
// 核心职责：
// 1. 将 /hf/* 路由请求映射到 Hugging Face Dataset 仓库的 raw / resolve 地址。
// 2. 原样支持并透传 HTTP Range 请求（206 Partial Content），确保游戏流式挂载。
// 3. 严格的缓存分层隔离：
//    - 游戏实体大文件 (*.xp3, *.dll, 音视频等)：CF 边缘节点与浏览器均缓存 1 年 (31536000s) + immutable。
//    - 游戏清单 (*manifest.json)：5 分钟 (300s) 短缓存，保证补丁及时刷新。
//    - 注入 CORS 与 Cross-Origin-Resource-Policy 头，避免跨域与 COEP 阻拦。

import { withSecurityHeaders } from './headers.js';

const ONE_YEAR_SECONDS = 31536000;
const FIVE_MINUTES_SECONDS = 300;

/**
 * 解析 /hf/* 路径为 Hugging Face 目标信息。
 *
 * 支持以下格式：
 * 1. /hf/gal/shuizangyinhuo/data.xp3
 *    -> repo: clown145/gal (使用默认 owner 'clown145' 或 env.HF_DEFAULT_OWNER)
 * 2. /hf/clown145/gal/shuizangyinhuo/data.xp3
 *    -> owner: clown145, repo: gal, branch: main
 * 3. /hf/clown145/gal/main/shuizangyinhuo/data.xp3
 *    -> owner: clown145, repo: gal, branch: main
 */
export function parseHfPath(pathname, defaultOwner = 'clown145', defaultRepo = 'gal') {
    const raw = pathname.replace(/^\/hf\/?/, '');
    const parts = raw.split('/').filter(Boolean);
    if (parts.length === 0) return null;

    let owner = defaultOwner;
    let repo = defaultRepo;
    let branch = 'main';
    let filePath = '';

    if (parts[0] === 'gal' || parts[0] === defaultRepo) {
        // 格式: /hf/gal/path/to/file
        owner = defaultOwner;
        repo = parts[0];
        filePath = parts.slice(1).join('/');
    } else if (parts.length >= 2 && !parts[0].includes('.')) {
        if (parts.length >= 3 && parts[2] === 'main') {
            // 格式: /hf/owner/repo/main/path/to/file
            owner = parts[0];
            repo = parts[1];
            branch = parts[2];
            filePath = parts.slice(3).join('/');
        } else {
            // 格式: /hf/owner/repo/path/to/file
            owner = parts[0];
            repo = parts[1];
            branch = 'main';
            filePath = parts.slice(2).join('/');
        }
    } else {
        // 格式: /hf/path/to/file (直接挂在默认仓库下)
        owner = defaultOwner;
        repo = defaultRepo;
        branch = 'main';
        filePath = parts.join('/');
    }

    if (!filePath) return null;

    // Hugging Face dataset resolve URL
    const targetUrl = `https://huggingface.co/datasets/${owner}/${repo}/resolve/${branch}/${filePath}`;
    const isManifest = filePath.toLowerCase().endsWith('manifest.json') || filePath.toLowerCase().endsWith('.json');

    return {
        owner,
        repo,
        branch,
        filePath,
        targetUrl,
        isManifest
    };
}

export async function handleHfProxy(request, env, ctx, pathname) {
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
                'Access-Control-Allow-Headers': 'Range, Content-Type, Authorization, If-None-Match, If-Modified-Since',
                'Access-Control-Max-Age': '86400',
                'Cross-Origin-Resource-Policy': 'cross-origin'
            }
        });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    const defaultOwner = env.HF_DEFAULT_OWNER || 'clown145';
    const defaultRepo = env.HF_DEFAULT_REPO || 'gal';
    const parsed = parseHfPath(pathname, defaultOwner, defaultRepo);

    if (!parsed) {
        return new Response('Invalid Hugging Face proxy path', { status: 400 });
    }

    const reqHeaders = new Headers();
    // 透传 Range、ETag 相关条件头
    const passHeaders = ['range', 'if-none-match', 'if-modified-since'];
    for (const h of passHeaders) {
        const val = request.headers.get(h);
        if (val) reqHeaders.set(h, val);
    }

    // 若配置了 HF_TOKEN，则附带认证头（支持私有仓库）
    const token = env.HF_TOKEN || '';
    if (token) {
        reqHeaders.set('Authorization', `Bearer ${token}`);
    }

    // 缓存控制：游戏实体资源在 Cloudflare CDN 边缘缓存 1 年，manifest 5 分钟
    const cfTtl = parsed.isManifest ? FIVE_MINUTES_SECONDS : ONE_YEAR_SECONDS;
    const fetchOptions = {
        method: request.method,
        headers: reqHeaders,
        redirect: 'follow'
    };

    // 如果运行在 Cloudflare Workers 环境且支持 cf 对象，开启 CDN 边缘缓存
    if (typeof request.cf !== 'undefined') {
        fetchOptions.cf = {
            cacheEverything: true,
            cacheTtl: cfTtl,
            cacheTtlByStatus: {
                '200-299': cfTtl,
                '404': 60,
                '500-599': 0
            }
        };
    }

    let upstreamRes;
    try {
        upstreamRes = await fetch(parsed.targetUrl, fetchOptions);
    } catch (err) {
        return new Response('Failed to fetch upstream from Hugging Face: ' + err.message, { status: 502 });
    }

    // 构建响应头
    const resHeaders = new Headers();

    // 复制重要的内容元数据
    const copyHeaders = [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'etag',
        'last-modified'
    ];
    for (const h of copyHeaders) {
        const val = upstreamRes.headers.get(h);
        if (val) resHeaders.set(h, val);
    }

    // 显式确保 accept-ranges 为 bytes
    if (!resHeaders.has('accept-ranges')) {
        resHeaders.set('accept-ranges', 'bytes');
    }

    // 注入跨域与安全隔离头
    resHeaders.set('Access-Control-Allow-Origin', '*');
    resHeaders.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, ETag, Last-Modified');
    resHeaders.set('Cross-Origin-Resource-Policy', 'cross-origin');

    // 注入精确的 Cache-Control 策略
    if (upstreamRes.ok || upstreamRes.status === 206 || upstreamRes.status === 304) {
        if (parsed.isManifest) {
            resHeaders.set('Cache-Control', `public, max-age=${FIVE_MINUTES_SECONDS}, must-revalidate`);
        } else {
            // 游戏大文件：强不可变缓存 1 年
            resHeaders.set('Cache-Control', `public, max-age=${ONE_YEAR_SECONDS}, s-maxage=${ONE_YEAR_SECONDS}, immutable`);
        }
    } else {
        resHeaders.set('Cache-Control', 'no-cache');
    }

    return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        statusText: upstreamRes.statusText,
        headers: resHeaders
    });
}
