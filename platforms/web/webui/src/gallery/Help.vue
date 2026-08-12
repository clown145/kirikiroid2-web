<script setup>
import { onMounted } from 'vue';
import AccountMenu from '../shared/AccountMenu.vue';

onMounted(() => {
    document.title = '帮助与说明 · 游戏库';
});
</script>

<template>
    <header class="help-nav">
        <a class="brand" href="/">
            <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20" aria-hidden="true">
                <path d="M21 6H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-10 7H8v3H6v-3H3v-2h3V8h2v3h3v2zm4.5 2c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm3-3c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z" />
            </svg>
            <span>Kirikiroid2</span>
        </a>
        <div class="help-nav-actions">
            <a class="btn btn-ghost btn-sm" href="/">返回游戏库</a>
            <AccountMenu />
        </div>
    </header>

    <main class="help-body">
        <header class="help-head">
            <p>使用文档</p>
            <h1>帮助与说明</h1>
            <span>游戏、下载和存档都由浏览器在这台设备上处理。</span>
        </header>

        <nav class="help-index" aria-label="本页目录">
            <a href="#playing">开始游戏</a>
            <a href="#compatibility">浏览器兼容性</a>
            <a href="#downloads">下载方式</a>
            <a href="#saves">本地存档</a>
            <a href="#sync">存档同步</a>
            <a href="#webdav">WebDAV</a>
            <a href="#privacy">隐私与数据</a>
            <a href="#troubleshooting">常见问题</a>
        </nav>

        <article class="help-content">
            <section id="playing">
                <h2>开始游戏</h2>
                <p>从游戏库点开作品，在详情页选择“开始游戏”。你也可以从用户菜单打开本地的 <code>.xp3</code>、<code>.zip</code> 或游戏文件夹。</p>
                <p>电脑上把鼠标移到画面最上方可唤出控制栏；支持的触屏设备可从顶边下滑。退出游戏会卸载当前引擎页面，但本地存档不会因此删除。</p>
            </section>

            <section id="compatibility">
                <h2>浏览器兼容性</h2>
                <p>游戏引擎依赖 WebAssembly JSPI、SharedArrayBuffer 和 WebGL。推荐在 Windows、macOS、Linux 或 Android 上使用 Chrome / Edge 137 及以上版本。</p>
                <p><strong>iPhone 和 iPad 当前无法运行游戏。</strong>iOS / iPadOS 上的所有浏览器都使用 WebKit，而这些系统上的 WebKit 目前完全不支持本项目所需的 JSPI；安装 iOS 版 Chrome、Edge 或 Firefox 也无法绕过这个限制。</p>
                <p>游戏库、账号和设置页面可能仍能打开，但这不代表游戏引擎能够启动。</p>
            </section>

            <section id="downloads">
                <h2>完整下载与边玩边下</h2>
                <dl class="help-compare">
                    <div>
                        <dt>直接开始</dt>
                        <dd>只在游戏需要时读取资源，可以更快进入作品。设置里的“游玩时继续下载资源”会在后台补齐尚未访问的资源。</dd>
                    </div>
                    <div>
                        <dt>完整下载</dt>
                        <dd>先把完整游戏包保存到浏览器存储或你选择的文件夹，之后游玩更少依赖网络。大型游戏建议保存到自己的文件夹。</dd>
                    </div>
                </dl>
                <p>浏览器内部存储可能在空间紧张或清理站点数据时被系统删除；保存到你选择的文件夹后，文件由你自己管理。</p>
            </section>

            <section id="saves">
                <h2>本地存档</h2>
                <p>存档默认保存在当前浏览器的 IndexedDB 中，并按游戏隔离。换浏览器、使用无痕模式或清除本站数据，都可能让原来的本地存档不可见。</p>
                <p>本地游玩不要求登录。建议定期手动同步，或从游戏内的存档管理导出 ZIP 备份。</p>
            </section>

            <section id="sync">
                <h2>存档同步</h2>
                <p>同步只会在你点击“同步”时进行。游戏运行期间、退出游戏或关闭标签页时都不会自动上传，以免每次剧情推进造成的文件变化覆盖其他设备上的进度。</p>
                <div class="sync-options" role="table" aria-label="同步后端对比">
                    <div class="sync-options-head" role="row">
                        <span role="columnheader">位置</span>
                        <span role="columnheader">账号要求</span>
                        <span role="columnheader">数据流向</span>
                    </div>
                    <div role="row">
                        <strong role="cell">站点云存档</strong>
                        <span role="cell">Steam 或 GitHub 登录</span>
                        <span role="cell">上传到本站的 R2 存储</span>
                    </div>
                    <div role="row">
                        <strong role="cell">WebDAV</strong>
                        <span role="cell">无需本站账号</span>
                        <span role="cell">浏览器直连你的 WebDAV</span>
                    </div>
                </div>
                <h3>发生冲突时</h3>
                <ul>
                    <li><strong>使用本机</strong>：把当前设备上的进度上传为最新版本。</li>
                    <li><strong>使用远端</strong>：用远端版本替换本机存档。</li>
                    <li><strong>下载两份</strong>：分别下载本机和远端 ZIP，暂不覆盖任何一边。</li>
                </ul>
                <p>同步前请比较设备名称和时间。时间戳用于辅助判断，不会在冲突时替你自动选择。</p>
            </section>

            <section id="webdav">
                <h2>WebDAV 配置要求</h2>
                <p>在设置中填写 HTTPS 地址、用户名、密码和远端目录。建议为本站创建应用专用密码，不要复用主账号密码。</p>
                <p>因为连接由浏览器直接发起，WebDAV 服务必须允许本站域名跨域访问，并满足以下条件：</p>
                <ul>
                    <li>支持 <code>GET</code>、<code>PUT</code>、<code>DELETE</code>、<code>MKCOL</code> 和 <code>OPTIONS</code>。</li>
                    <li>CORS 允许 <code>Authorization</code>、<code>If-Match</code> 和 <code>If-None-Match</code> 请求头。</li>
                    <li>CORS 通过 <code>Access-Control-Expose-Headers</code> 暴露 <code>ETag</code>。</li>
                </ul>
                <p>部分公共 WebDAV 服务不开放浏览器跨域访问，即使同一组账号能在桌面客户端中使用，也可能无法在本站连接。</p>
            </section>

            <section id="privacy">
                <h2>隐私与数据流</h2>
                <ul>
                    <li>游戏引擎和剧情在你的设备上运行。</li>
                    <li>本地存档位于浏览器 IndexedDB，不会因为登录自动上传。</li>
                    <li>选择站点云存档时，手动同步的数据会传到本站 R2。</li>
                    <li>选择 WebDAV 时，浏览器直接连接你填写的服务器，地址和凭据不会发送给本站。</li>
                    <li>WebDAV 密码只有开启“在这台设备上记住密码”后才会保存在浏览器本地。</li>
                </ul>
            </section>

            <section id="troubleshooting">
                <h2>常见问题</h2>
                <details>
                    <summary>换了浏览器后为什么看不到存档？</summary>
                    <p>本地存档属于原浏览器的站点数据。请在原浏览器先手动同步，再在新浏览器选择相同的同步位置并同步。</p>
                </details>
                <details>
                    <summary>WebDAV 测试为什么失败？</summary>
                    <p>先确认使用 HTTPS、地址包含正确的用户路径、账号允许 WebDAV；若桌面客户端可用但网页失败，通常是服务端没有按上面的要求开放 CORS。</p>
                </details>
                <details>
                    <summary>两个设备都玩过，应该选择哪个版本？</summary>
                    <p>先看设备名称和更新时间。无法判断时选择“下载两份”，保留两个 ZIP 后再决定，不要直接覆盖。</p>
                </details>
                <details>
                    <summary>退出登录会删除什么？</summary>
                    <p>退出时可以选择保留或清空本地存档。远端存档、游戏下载缓存和外部游戏文件夹都不会被删除。</p>
                </details>
            </section>
        </article>
    </main>
</template>

<style scoped>
.help-nav { position: sticky; top: 0; z-index: var(--z-toolbar); display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: var(--space-3) var(--space-5); border-bottom: 1px solid var(--line); background: rgba(10, 10, 11, .86); backdrop-filter: blur(16px); }
.brand { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; }
.brand svg { color: var(--fg-1); }
.help-nav-actions { display: flex; align-items: center; gap: 8px; }
.help-body { width: min(860px, calc(100% - 32px)); margin: 0 auto; padding: 42px 0 88px; }
.help-head { padding-bottom: 28px; border-bottom: 1px solid var(--line-strong); }
.help-head p { margin: 0 0 8px; color: var(--fg-2); font-size: 11px; }
.help-head h1 { margin: 0 0 9px; font-size: 28px; letter-spacing: 0; }
.help-head span { color: var(--fg-1); font-size: 13px; line-height: 1.7; }
.help-index { display: flex; flex-wrap: wrap; gap: 7px 18px; padding: 18px 0; border-bottom: 1px solid var(--line); color: var(--fg-1); font-size: 12px; }
.help-index a:hover { color: var(--fg-0); text-decoration: underline; }
.help-content section { padding: 32px 0; border-bottom: 1px solid var(--line); scroll-margin-top: 72px; }
.help-content h2 { margin: 0 0 14px; font-size: 17px; }
.help-content h3 { margin: 24px 0 10px; font-size: 13px; }
.help-content p, .help-content li, .help-content dd { color: var(--fg-1); font-size: 13px; line-height: 1.8; }
.help-content p { margin: 0 0 12px; }
.help-content p:last-child { margin-bottom: 0; }
.help-content ul { margin: 0; padding-left: 20px; }
.help-content li + li { margin-top: 5px; }
.help-content strong { color: var(--fg-0); font-weight: 550; }
.help-content code { padding: 1px 5px; border: 1px solid var(--line); border-radius: 4px; background: var(--bg-2); color: var(--fg-0); font-size: 12px; }
.help-compare { display: grid; grid-template-columns: 1fr 1fr; margin: 0 0 14px; border-top: 1px solid var(--line); }
.help-compare div { padding: 15px 18px 15px 0; border-bottom: 1px solid var(--line); }
.help-compare div + div { padding-left: 18px; border-left: 1px solid var(--line); }
.help-compare dt { margin-bottom: 6px; font-size: 13px; font-weight: 550; }
.help-compare dd { margin: 0; }
.sync-options { margin: 18px 0 24px; border-top: 1px solid var(--line-strong); }
.sync-options > div { display: grid; grid-template-columns: 150px 180px minmax(0, 1fr); gap: 14px; padding: 11px 0; border-bottom: 1px solid var(--line); color: var(--fg-1); font-size: 12px; line-height: 1.6; }
.sync-options .sync-options-head { color: var(--fg-2); font-size: 10px; }
.sync-options strong { font-size: 12px; }
.help-content details { border-top: 1px solid var(--line); }
.help-content details:last-child { border-bottom: 1px solid var(--line); }
.help-content summary { cursor: pointer; padding: 14px 0; color: var(--fg-0); font-size: 13px; font-weight: 550; }
.help-content details p { padding: 0 0 15px; }
@media (max-width: 680px) {
    .help-nav { padding: var(--space-3) var(--space-4); }
    .brand span, .help-nav-actions > a { display: none; }
    .help-body { width: min(100% - 24px, 860px); padding-top: 26px; }
    .help-head h1 { font-size: 24px; }
    .help-compare { grid-template-columns: 1fr; }
    .help-compare div { padding-right: 0; }
    .help-compare div + div { padding-left: 0; border-left: 0; }
    .sync-options > div { grid-template-columns: 100px minmax(0, 1fr); }
    .sync-options > div > :last-child { grid-column: 2; }
    .sync-options-head > :last-child { display: none; }
}
</style>
