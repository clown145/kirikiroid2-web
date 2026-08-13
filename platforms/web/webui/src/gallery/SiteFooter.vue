<script setup>
import { computed } from 'vue';
import { showConfirm } from '../shared/dialog.js';

const config = computed(() => window.KrKr2Config || {});
const buildVersion = computed(() => config.value.buildVersion || 'dev');

async function onForceUpdate(e) {
    e.preventDefault();
    const ok = await showConfirm({
        title: '强制更新应用',
        message: '清除缓存的应用文件并加载最新版本？\n存档数据保存在本地数据库中，不受影响。',
        confirmText: '清除并更新',
        danger: false
    });
    if (ok) {
        window.KrKr2PWA?.forceUpdate?.();
    }
}
</script>

<template>
    <footer class="site-footer">
        <details>
            <summary>关于本站</summary>
            <div class="about">
                <p>在浏览器里直接运行 Kirikiroid2（吉里吉里2）游戏，不需要安装客户端。游戏完全在你的设备上运行；存档只在你手动同步时传输，可选择站点云端或自己的 WebDAV。</p>
                <p><a href="/help">查看完整的使用、存档同步与 WebDAV 配置说明</a></p>
            </div>
        </details>

        <p class="footer-links">
            <a href="/help">帮助与说明</a>
            <span aria-hidden="true">·</span>
            <a href="#" title="清除缓存的应用文件并加载最新版本（存档保留）" @click="onForceUpdate">强制更新</a>
            <span aria-hidden="true">·</span>
            <span>Build {{ buildVersion }}</span>
        </p>
    </footer>
</template>

<style scoped>
.site-footer {
    max-width: 1400px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-5) var(--space-7);
    color: var(--fg-2);
}

.site-footer details {
    border-top: 1px solid var(--line);
    padding-top: var(--space-4);
}

.site-footer summary {
    cursor: pointer;
    font-size: 13px;
    color: var(--fg-1);
    list-style: none;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    user-select: none;
}

.site-footer summary::-webkit-details-marker { display: none; }

.site-footer summary::before {
    content: '';
    width: 0;
    height: 0;
    border-left: 5px solid currentColor;
    border-top: 4px solid transparent;
    border-bottom: 4px solid transparent;
    transition: transform var(--dur) var(--ease);
}

.site-footer details[open] summary::before { transform: rotate(90deg); }
.site-footer summary:hover { color: var(--fg-0); }

.site-footer .about {
    padding: var(--space-4) 0 var(--space-2);
    font-size: 13px;
    line-height: 1.75;
    color: var(--fg-1);
    max-width: 760px;
}

.site-footer .about p { margin: 0 0 var(--space-3); }
.site-footer .about a { color: var(--fg-0); text-decoration: underline; }

.footer-links {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    margin: var(--space-5) 0 0;
    padding-top: var(--space-4);
    border-top: 1px solid var(--line);
    font-size: 12px;
}

.footer-links a { color: var(--fg-1); }
.footer-links a:hover { color: var(--fg-0); text-decoration: underline; }

@media (max-width: 640px) {
    .site-footer { padding: var(--space-5) var(--space-4) var(--space-6); }
}
</style>
