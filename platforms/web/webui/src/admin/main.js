import { createApp, h } from 'vue';
import '../styles/base.css';
import Login from './Login.vue';
import FolderAccessGate from '../shared/FolderAccessGate.vue';
import ToastContainer from '../shared/ToastContainer.vue';
import ConfirmDialog from '../shared/ConfirmDialog.vue';

createApp({
    render: () => [
        h(Login),
        h(FolderAccessGate),
        h(ToastContainer),
        h(ConfirmDialog)
    ]
}).mount('#app');
