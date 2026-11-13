# 网易云音乐下载器

基于 [GD 音乐台 API](https://music.gdstudio.xyz/) 的网易云歌单批量下载器，Electron 桌面 GUI。
输入歌单链接 → 解析 → 选目录/音质 → 一键下载，自动跳过 VIP/无版权歌曲并生成清单。

> 仅供个人学习与欣赏，请支持正版音乐。

## 功能

- 粘贴歌单链接或纯数字 ID，解析歌单名 / 创作者 / 曲目数
- 批量下载，可选音质（320 / 192 / 128k，自动降级）与并发数（1–6）
- 实时进度条 + 逐首 OK / SKIP 日志
- 跳过清单（VIP / 无版权）与 `_下载报告.json`
- 文件名自动清洗非法字符、同名自动加序号
- 可中途取消、一键打开输出目录

## 下载

前往 [Releases](../../releases) 下载 `NeteaseMusicDownloader-Setup-x.y.z.exe` 安装包（Windows x64）。

## 构建

安装包由 GitHub Actions 云端构建（`.github/workflows/build.yml`）：

- push 到 `main` 或打 `v*` tag 触发，也可手动 `workflow_dispatch`
- `windows-latest` + Node 22 → `npm ci` → `npm run dist`（`electron-builder --win nsis`）
- 校验 sha256、上传 artifact；`v*` tag 自动发 Release

> 本地无需运行 Electron（部分机器 dev 模式 Electron 会崩溃），exe 一律交给 CI 构建。

## 本地开发

```bash
npm install
npm start      # 运行（需本地 Electron 可用）
npm run dist   # 打包 NSIS 安装包到 out-electron/
```

## 技术栈

Electron 38 + electron-builder 26 · 原生 HTML/CSS/JS 前端 · Node fetch 下载核心 · contextIsolation 安全 IPC

## 项目结构

```
main.js                      主进程：窗口 / 单实例 / IPC
preload.js                   安全桥（window.api）
downloader.js                下载核心（GD 音乐台 API）
ui/index.html ui/app.js ui/style.css   前端界面
.github/workflows/build.yml  CI 构建
```

## License

MIT © dkvkvk