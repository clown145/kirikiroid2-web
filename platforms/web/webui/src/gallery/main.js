import { createApp, h } from 'vue';
import '../styles/base.css';
import '../styles/footer.css';
import Gallery from './Gallery.vue';
import GameDetail from './GameDetail.vue';
import Help from './Help.vue';
import Settings from './Settings.vue';
import FolderAccessGate from '../shared/FolderAccessGate.vue';
import ToastContainer from '../shared/ToastContainer.vue';
import ConfirmDialog from '../shared/ConfirmDialog.vue';
import AccountCredentialsDialog from '../shared/AccountCredentialsDialog.vue';

// 游戏详情页和画廊共用这套轻量入口；播放页仍然是独立 MPA，
// 这样进入引擎时仍会销毁整个 gallery document。
const cleanPath = location.pathname.replace(/\/+$/, '') || '/';
const isDetailPage = /^\/game\/[^/]+$/.test(cleanPath);
const rootComponent = cleanPath === '/settings'
    ? Settings
    : (cleanPath === '/help' ? Help : (isDetailPage ? GameDetail : Gallery));

createApp({
    render: () => [
        h(rootComponent),
        h(FolderAccessGate),
        h(ToastContainer),
        h(ConfirmDialog),
        h(AccountCredentialsDialog)
    ]
}).mount('#app');
