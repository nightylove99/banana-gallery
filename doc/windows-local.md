# Banana Gallery Windows 本地版

本包用于个人收集、整理 AI 图片：Gemini 网页有保存扩展；NovelAI 当前先下载原图，再在画廊手动上传、填写提示词。NovelAI 一键保存和自动解析生成参数尚未实现。

不需要购买生图 API、不需要配置 API Key，也不需要安装数据库、Git、Docker、WSL 或 Python。没有 API Key 时，可以用内置免费演示渠道生成本机占位图；使用在线模型时再配置对应渠道。

这是首次安装需要联网下载依赖的分发包，不是离线免安装 EXE。包内已经构建好网页。已在 Windows x64 实机验证 `gallery.cmd` 安装、启动、重启、停止、校验和备份；首次使用仍建议先用几张测试图片走一遍文末的验收步骤。

## 第一次安装

1. 从 https://nodejs.org/en/download 安装 **Node.js 24 LTS** 的 Windows 安装版，保留 npm 和 PATH 默认选项。不需要勾选额外的原生编译工具。已有 22.23+ 也可使用；优先使用 24 LTS。
2. 将 ZIP **完整解压**到固定目录，例如 `C:\BananaGallery\banana-gallery-0.12.0-windows`。不要直接在压缩包里打开程序，也不要把程序放在会自动清理的临时目录。
3. 双击 `gallery.cmd`，选择 `1` 安装依赖。首次需要联网；安装失败保留窗口报错，优先检查 Node.js 和网络连接。
4. 选择 `2` 启动，浏览器会打开 http://localhost:3333 ，无需登录。
5. 选择 `8` 关闭菜单，画廊仍在后台运行。关闭浏览器也不会停止服务。重启电脑后需要重新选择 `2`。

菜单使用英文标签以减少 Windows 控制台编码问题，依次是：安装、启动、停止、状态、日志、备份、数据校验、关闭菜单。

命令行等价用法（PowerShell，在解压目录执行）：

```powershell
.\gallery.cmd install
.\gallery.cmd start
.\gallery.cmd status
.\gallery.cmd log
.\gallery.cmd stop
.\gallery.cmd backup
.\gallery.cmd verify
.\gallery.cmd restart
```

## 安装 Gemini 扩展

1. 保持本地画廊运行。
2. Chrome 打开 `chrome://extensions`，或 Edge 打开 `edge://extensions`。
3. 打开“开发者模式”，点击“加载已解压的扩展程序”。
4. 选择本包内 `app\extension\gemini-to-banana` 文件夹。
5. 扩展默认 API 地址为 `http://localhost:3333`，保持默认。
6. 打开或刷新 https://gemini.google.com/ ，生成图片后点击“保存到 Banana”。检查结果图、提示词和参考图，再确认保存。

参考图无法全部读取时，确认面板会提示。需要完整参考图时，重新上传参考图、生成后再保存。

## NovelAI 暂时怎么用

在 https://novelai.net/ 下载生成的原始图片，保留原文件，然后在 Banana Gallery 上传。提示词暂时手动填写，可加 `novelai` 标签。

此版本不会自动提取 NovelAI 的负向提示词、角色提示词、种子等参数。不要把截图或聊天软件压缩后的图当作可复现原图。当前没有在 NovelAI 页面插入按钮。

## 图片存在哪里

默认数据目录：`%LOCALAPPDATA%\BananaGallery\data`。在资源管理器地址栏粘贴这个路径即可打开。

需要一起保留：

- `gallery-data.json`：提示词、标签、收藏和条目索引（保存首个条目后生成）。
- `public\images`：原图。
- `public\references`：参考图。

日志：`%LOCALAPPDATA%\BananaGallery\gallery.log`。
备份：`%LOCALAPPDATA%\BananaGallery\backups`。

没有后台同步到云端。首次依赖安装与访问 Gemini/NovelAI 网站需要联网；导入的图库可以在本地管理。

## 备份、恢复和升级

备份：先停止服务，再选择 `6`。程序先检查条目引用的图片是否齐全，再把索引、原图和参考图一起复制到新的时间戳目录，不覆盖旧备份。备份与原数据在同一块盘时不能防硬盘损坏，请再把整个备份目录复制到其他磁盘。

恢复：停止服务，将当前 `data` 文件夹改名保留，把一个完整备份复制为新的 `data`，然后运行 `verify`。校验通过后启动。不要将不同日期的 JSON 和图片目录混合恢复，也不要只恢复 JSON。`backup-info.json` 仅是备份说明，不影响使用。

升级：先停止旧版、备份，再把新版解压到另一个目录。用新版运行 `install` 和 `verify`，再启动。默认会沿用上述数据目录。确认图片、提示词、参考图都正常后，再决定是否删除旧程序。升级扩展时，在扩展管理页移除旧目录的扩展、加载新版目录，并刷新 Gemini 页面。

回退：停止新版，使用旧程序。若新版变更了数据格式，先恢复升级前的完整备份，再用旧程序校验、启动。保留新版数据副本以免丢失升级后新增的作品。

## 常见问题

- 提示找不到 Node：安装 Node.js 24 LTS，重新打开菜单或终端。
- 安装下载失败：检查 npm registry 网络连通性后重试 `install`；不要关闭 TLS 校验、全局关闭防火墙或直接复制其他电脑的 `node_modules`。
- 端口 3333 被占用：运行 `status`、查看 `log`；确认占用程序后处理，不要批量结束所有 Node 进程。本包不会自动杀死其他程序。
- 状态显示旧程序路径：先用旧版 `stop`，再启动新版。同一个数据目录只允许运行一个本地分发实例。
- 提示正在运行，无法备份或校验：先停止，再操作。安装和备份期间也不允许启动第二个写入实例。
- 页面未刷新：刷新浏览器；升级后仍显示旧页面时，对 localhost:3333 清理站点缓存再打开。
- 想用 D 盘保存：安装前可由 Work Buddy 设置当前 Windows 用户的 `BANANA_GALLERY_DATA_DIR` 为绝对路径，如 `D:\BananaGalleryData\data`，然后重新打开终端。已有数据需要停机、完整迁移三项数据后再切换路径。不要让多个数据目录共用相同父目录的日志和备份位置。

## 首次验收

1. 无 API Key 时启动成功，直接进入画廊。
2. 从 Gemini 保存一张带提示词、参考图的图片，打开详情核对。
3. 手动上传一张 NovelAI 原图，添加标签和提示词。
4. 停止再启动，检查原图、提示词、标签和参考图还在。
5. 停止、备份、校验成功，记录备份目录。
6. 关闭菜单后仍能访问；重启电脑后再次启动成功。

仅本机访问，不需要开放防火墙入站端口或配置公网域名。


## 可选：外部 Agent CLI

网页仍不需要 Python。要使用 CLI，另装 Python 3.10+，从解压目录运行
`py -3 .\app\scripts\banana-gallery.py ensure`。CLI 不会自动启动服务，请先运行
`.\gallery.cmd start`。接入示例见 `app/skills/banana-gallery/SKILL.md` 和 `app/doc/api-v1.md`；
如要配置实例令牌，将 `BANANA_GALLERY_API_TOKEN` 写入安装目录内 `app/.env.windows-distribution`，
再在 Agent 进程里设置 `BANANA_GALLERY_TOKEN`。
