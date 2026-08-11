import { createApp } from 'vue';
import '../styles/base.css';
import '../styles/footer.css';
import Gallery from './Gallery.vue';
import GameDetail from './GameDetail.vue';

// 游戏详情页和画廊共用这套轻量入口；播放页仍然是独立 MPA，
// 这样进入引擎时仍会销毁整个 gallery document。
const isDetailPage = /^\/game\/[^/]+\/?$/.test(location.pathname);
createApp(isDetailPage ? GameDetail : Gallery).mount('#app');
