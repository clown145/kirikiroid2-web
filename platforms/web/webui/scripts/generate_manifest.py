#!/usr/bin/env python3
import os
import sys
import json
import urllib.parse

def generate_manifest(local_folder, base_url=""):
    local_folder = os.path.abspath(local_folder)
    if base_url and not base_url.endswith('/'):
        base_url += '/'

    if not os.path.exists(local_folder) or not os.path.isdir(local_folder):
        print(f"Error: Directory not found -> {local_folder}")
        sys.exit(1)

    files_list = []

    # 遍历目录
    for root, _, files in os.walk(local_folder):
        for file in files:
            # 排除系统级隐藏文件、无用文件及自身 manifest.json
            if file in ['.DS_Store', 'Thumbs.db', 'manifest.json'] or file.endswith('.exe'):
                continue

            full_path = os.path.join(root, file)
            # 计算相对于本地根目录的相对路径
            relative_path = os.path.relpath(full_path, local_folder)
            # 将 Windows 风格的路径分隔符替换为 POSIX 正斜杠
            normalized_name = relative_path.replace(os.sep, '/')
            
            # 获取文件大小
            size = os.path.getsize(full_path)
            
            item = {
                "name": normalized_name,
                "size": size
            }

            if base_url:
                # 使用 urllib.parse.quote 对路径中的每一部分进行 URL 编码
                url_parts = [urllib.parse.quote(part) for part in normalized_name.split('/')]
                item["url"] = base_url + '/'.join(url_parts)

            files_list.append(item)

    return files_list

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python generate_manifest.py <local_game_folder> [r2_base_url]")
        print("Example (免 URL 模式): python generate_manifest.py ./mygame")
        print("Example (指定 URL 模式): python generate_manifest.py ./mygame https://pub-xxx.r2.dev/mygame/")
        sys.exit(1)

    local_game_folder = sys.argv[1]
    r2_base_url = sys.argv[2] if len(sys.argv) > 2 else ""

    print(f"Scanning local folder: {local_game_folder}")
    manifest_data = generate_manifest(local_game_folder, r2_base_url)

    output_path = os.path.join(os.path.abspath(local_game_folder), 'manifest.json')
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(manifest_data, f, indent=2, ensure_ascii=False)

    print("\n✅ Generated manifest.json successfully!")
    print(f"Total files: {len(manifest_data)}")
    print(f"Output path: {output_path}\n")
    print("How to use:")
    print("1. Upload the game folder (including manifest.json) to your R2/S3/WebDAV storage.")
    print("2. In the web game gallery admin panel, set the downloadUrl to: <uploaded_url>/manifest.json")
