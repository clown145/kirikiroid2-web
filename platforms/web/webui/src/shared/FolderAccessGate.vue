<script setup>
import { onMounted, onUnmounted } from 'vue';
import FolderPermissionDialog from './FolderPermissionDialog.vue';
import { useFolderAccess } from './folderAccess.js';

const props = defineProps({ blocking: { type: Boolean, default: false } });
const access = useFolderAccess();

function check() {
    access.check({ prompt: true, block: props.blocking });
}

function onVisibilityChange() {
    if (document.visibilityState === 'visible') check();
}

function unbind() {
    if (!confirm('解除绑定不会删除磁盘上的游戏和存档文件，之后页面将不再使用这个文件夹。继续吗？')) return;
    access.unbind();
}

onMounted(() => {
    check();
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', onVisibilityChange);
});

onUnmounted(() => {
    window.removeEventListener('focus', check);
    document.removeEventListener('visibilitychange', onVisibilityChange);
});
</script>

<template>
    <FolderPermissionDialog
        v-if="access.visible.value"
        :folder-name="access.folderName.value"
        :restoring="access.restoring.value"
        :error="access.error.value"
        :blocking="access.blocking.value"
        @restore="access.restore"
        @ignore="access.ignore"
        @unbind="unbind" />
</template>
