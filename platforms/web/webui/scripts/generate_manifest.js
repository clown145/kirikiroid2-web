#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

// 命令行参数
const args = process.argv.slice(2);

if (args.length < 1) {
    console.error('Usage: node generate_manifest.js <local_game_folder> [r2_base_url]');
    console.error('Example (免 URL 模式): node generate_manifest.js ./mygame');
    console.error('Example (指定 URL 模式): node generate_manifest.js ./mygame https://pub-xxx.r2.dev/mygame/');
    process.exit(1);
}

const localFolder = path.resolve(args[0]);
let baseUrl = args[1] || '';
if (baseUrl && !baseUrl.endsWith('/')) {
    baseUrl += '/';
}

if (!fs.existsSync(localFolder)) {
    console.error(`Error: Folder not found -> ${localFolder}`);
    process.exit(1);
}

// 遍历目录并收集文件信息
function scanDirectory(dir, relativePath = '') {
    let filesList = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const itemRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
            filesList = filesList.concat(scanDirectory(fullPath, itemRelativePath));
        } else {
            // 排除系统生成的隐藏文件、无用文件以及自身 manifest.json
            if (
                entry.name === '.DS_Store' ||
                entry.name === 'Thumbs.db' ||
                entry.name === 'manifest.json' ||
                entry.name.endsWith('.exe')
            ) {
                continue;
            }
            
            const stats = fs.statSync(fullPath);
            
            // 路径归一化（统一使用 POSIX 正斜杠格式）
            const normalizedName = itemRelativePath.replace(/\\/g, '/');
            
            const item = {
                name: normalizedName,
                size: stats.size
            };

            if (baseUrl) {
                // encodeURIComponent 确保包含空格和特殊字符的文件名在 URL 中正确传递
                item.url = baseUrl + normalizedName.split('/').map(encodeURIComponent).join('/');
            }

            filesList.push(item);
        }
    }
    
    return filesList;
}

console.log(`Scanning local folder: ${localFolder}`);
const manifest = scanDirectory(localFolder);

const outputPath = path.join(localFolder, 'manifest.json');
fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2), 'utf-8');

console.log(`\n✅ Generated manifest.json successfully!`);
console.log(`Total files: ${manifest.length}`);
console.log(`Output path: ${outputPath}\n`);
console.log(`How to use:`);
console.log(`1. Upload the game folder (including manifest.json) to your R2/S3/WebDAV storage.`);
console.log(`2. In the web game gallery admin panel, set the downloadUrl to: <uploaded_url>/manifest.json`);
