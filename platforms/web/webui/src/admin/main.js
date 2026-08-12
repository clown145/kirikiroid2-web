import { createApp, h } from 'vue';
import '../styles/base.css';
import Login from './Login.vue';
import FolderAccessGate from '../shared/FolderAccessGate.vue';

createApp({
    render: () => [h(Login), h(FolderAccessGate)]
}).mount('#app');
