# 本地单机版使用说明

日常在自己电脑上使用 Banana Gallery 的快捷方式。

本文的 `gallery.sh` 用于 Mac 长期自用。Windows 分发包使用同一产品的 `personal` 模式，通过包内 `gallery.cmd` 管理，见 [`windows-local.md`](windows-local.md)；图片保存在 Windows 用户目录，和程序版本目录分开。

## 跨平台单端口启动

在 Windows、macOS 或 Linux 上安装 Node.js 24 LTS，然后在项目目录执行：

```sh
npm ci
npm run build
npm start
```

打开 **http://127.0.0.1:3333**，同一端口提供网页和 API。用 Ctrl+C 停止。
`GET /api/health` 无需登录，可查询服务状态、版本和认证模式。
开发时用 `npm run dev:all` 同时启动后端和 Vite；只启动 Vite 用 `npm run dev`。
外部 Agent 接入见 [API v1 与可选令牌](api-v1.md) 和 [随仓 Skill](../skills/banana-gallery/SKILL.md)。

## macOS 日用启停

```bash
./gallery.sh start    # 启动后台服务
./gallery.sh stop     # 停止
./gallery.sh restart  # 重启
./gallery.sh status   # 查看运行状态
./gallery.sh log      # 查看实时日志（Ctrl+C 退出）
```

启动后访问 **http://localhost:5173**，无需登录，直接可用。停止或重启前，脚本会检查执行中的任务；重启还会检查排队任务。无法确认队列空闲时会拒绝操作；确需中断时可加 `--force`。

## 私有远程访问

远程访问仍以本机文件为唯一数据源，但使用独立的 Cloudflare Access 认证端口：

1. 将 `.env.example` 复制为 `.env.personal-remote` 并填写 Access 参数。
2. 将 `.banana-gallery.profile` 的唯一一行设为 `cloudflare_access`。
3. 执行 `npm run build` 后，仍使用 `./gallery.sh start|stop|status|log` 管理应用。
4. Cloudflare Tunnel 只连接 `http://127.0.0.1:3334`。

此模式下同一 Node 进程同时提供：

- `127.0.0.1:3333`：本机入口，直接使用本地 session
- `127.0.0.1:3334`：远程源站，网页验证 Cloudflare Access JWT，受限 Agent API 也可用单独配置的 Bearer 令牌

禁止将 `3333` 或 Vite `5173` 配置为公网 Tunnel 源站。

Cloudflare Access 的重新登录频率由 Access 控制台中的全局、应用和策略 Session
Duration 决定，不由 Banana Gallery session 决定。个人自用若希望减少重复登录，可将三层中实际
生效的最短时长统一调长；若策略包含 IP、国家、WARP 或设备姿态条件，网络切换后仍可能立即被
重新评估。

## 说明

- 脚本自动以本机免登录模式（`AUTH_MODE=local`）启动，固定使用 JSON 元数据和磁盘文件
- 若 `.banana-gallery.profile` 为 `cloudflare_access`，脚本改为读取 `.env.personal-remote`，但数据仍是同一份 JSON 与磁盘目录
- 日志写入项目根目录 `.banana-gallery.log`
- PID 记录在项目根目录的 `.banana-gallery.*.pid`，用于停止时定位进程
- `status` 会同时检查前端和后端；若只有前端可用、后端不可用，应执行 `./gallery.sh restart` 并查看日志
- 生成页优先使用 Google Gemini；未配置 Google 凭据时默认选择「免费演示」，在本地生成占位图，不会调用任何付费接口。也可切换到已配置的 OpenAI 兼容、Seedream、Qwen 或 Kling 渠道
- 凭据可通过环境变量或本地 `.env` 配置，变量见 `.env.example`。Gemini 可用 `GEMINI_API_KEY` / `GOOGLE_API_KEY`，或通过 `GOOGLE_APPLICATION_CREDENTIALS` / `BANANA_GALLERY_SERVICE_ACCOUNT_PATH` 指定服务账号 JSON。使用 launchd 时，可将配置放在对应的本地环境文件里
- 从服务器本机路径导入默认关闭。仅在 `AUTH_MODE=local` 时可以用 `ALLOW_SERVER_SIDE_IMPORT=true` 开启；Cloudflare Access 模式下，两个入口都不允许这种导入
- 任一供应商凭据缺失或暂时读不到时，服务仍会启动并允许本地直进；只禁用对应供应商

## macOS 服务托管

`./gallery.sh start` 通过用户级 launchd 启动服务。首次启动会安装
`~/Library/LaunchAgents/com.banana.gallery.plist`，已有同一目录的配置会继续使用。
使用旧版 tmux 启动的实例，可在生图队列空闲时执行 `./gallery.sh restart` 迁移。

所有终端和 Agent 都使用同一组启停命令。前后端由 launchd 启动，关闭或强制退出发出命令的应用后仍会运行。
`./gallery.sh status` 会显示托管方式。`./gallery.sh stop` 卸载本次登录会话中的服务，
保留登录自启配置，下次登录仍会启动。日用运行模式由 `.banana-gallery.profile` 决定。

## 数据位置

| 内容 | 路径 |
|------|------|
| 图片元数据 | `gallery-data.json` |
| 生图历史与渠道冷却状态 | `generation-tasks.json`（首次写入任务状态时自动生成） |
| 画廊图片 | `public/images/` |
| 参考图 | `public/references/` |

备份或换机时需一并拷贝以上文件；旧版把生图历史嵌在 `gallery-data.json` 里，新版会自动读取，不用手动迁移。分离后的任务索引由内置备份、校验和恢复命令一并处理。已经升级且生成独立任务索引后，不要只用旧版程序打开同一目录；回退时应使用升级前的完整备份。

缩略图和浏览器缓存均可重建，不属于备份必需数据。快速滑动时先显示小预览，停下后升级清晰图；已看过的缩略图由浏览器按身份隔离保存。文件替换或恢复备份后版本会变化，刷新图库即可重新取图。缓存限制和清理说明见 [图片加载](gallery-loading.md)。

## 一致备份与恢复

- `./gallery.sh backup`：生成含原索引、被引用原图与有序参考图的快照，返回备份编号。写入与备份共用跨进程锁。
- `./gallery.sh verify <编号>`：逐文件校验 SHA-256、大小、索引引用完整性。
- `./gallery.sh restore <编号> --to <空目录>`：先校验，恢复到独立空目录供核验，不覆盖已有文件。
- 原位置恢复：先 `./gallery.sh stop`，再 `./gallery.sh restore <编号> --in-place`，核验后 `./gallery.sh start`、`./gallery.sh status`。恢复前的索引和整个图片目录（含未入库图片）保留在 `before-restore-*`，安装失败会撤回已完成的替换。恢复目录不自动清理。

可通过 `BANANA_GALLERY_BACKUP_DIR` 指定备份目的地绝对路径；默认实际数据目录下 `backups/`。命令加载当前 profile 的项目配置；不会备份 `.env`、密钥或浏览器草稿。手动备份目前不自动删除。设置页有创建/校验入口；远程 Access 只展示备份状态。不要在写图库的其他未受管理进程运行时覆盖恢复。原位置恢复先把已校验的备份复制到数据盘，再在数据盘完成原子替换；恢复前目录位于数据目录的 `recovery/before-restore-*`，支持备份放在另一块磁盘。

### 回收站与自动备份

从侧边栏「当前浏览 → 回收站」进入独立页面，角标显示作品和配方的回收站条目数，不包含生成历史。点击条目可预览原图、提示词和参考图，也可多选恢复或永久删除。普通删除保留文件与元数据，恢复沿用原 ID；原图缺失时仍可恢复元数据。永久删除需确认，只清理没有其他条目引用的文件。清理中途失败的条目会标为待清理，只能重试清理，不能恢复。回收站不会自动清空，仍计入存储和完整备份。

自动备份默认关闭，设置页启用并保存后创建首次基线。默认间隔 24 小时、最多 11 份、20 GB；间隔支持 1–168 小时，份数 1–100，容量 1 MB–1 TB。服务每分钟检查一次，到期且索引有变化才创建，休眠/停服期间不运行；新快照完整并通过校验后才按份数与容量清理旧自动快照。手动快照、未知文件及 before-restore 目录不参与。单份超过容量或缺图/磁盘失败时停止并在设置页提示，之前有效备份保留。

### 生成草稿恢复

生成页按浏览器 origin、用户与 workspace 保存多份草稿：提示词、所选模型和参数、有序参考图。草稿元数据和本地 File/Blob 一起存入 IndexedDB；原有草稿会自动迁移。临时 object URL 不写入持久记录。切页和刷新后可恢复，参考图按顺序上传，逐张保留回执；临时引用过期后可以用草稿里的原文件补传。从配方进入时已有内容会出现继续当前、另开草稿或明确替换的选择。

草稿不跨域/设备同步，也不包含在服务器备份里。清除站点数据会丢失草稿。保存失败会显示错误与重试；页面尚未关闭时保留待保存内容，刷新/关闭前有未完成写入或错误会触发浏览器离开提醒。Blob 缺失不假装恢复成功，提示重新添加；原模型已不可用时要求手动选择，避免自动切换供应商。

生成提交回执丢失时，页面会先用原提交标识核对，只有查不到接单记录时才提供重试。上游超时或返回 5xx 且没有可查询的原任务时，队列不会自动重投；如已有原任务标识，只继续查询或取图。

## 生图渠道

- **免费演示**：无需配置。在网页生成页选择「免费演示 · 本地占位图」即可试跑。CLI 的 `models` 可通过 `--provider demo --available-only` 发现该模型；也可用 `--provider demo --model banana-demo-v1` 提交生成。设 `ENABLE_DEMO_PROVIDER=false` 可关闭演示渠道。
- **Google Gemini**：任选 API Key 或 Vertex AI 服务账号 JSON，配置见 `.env.example`；两者均配置时优先使用服务账号。
- **OpenAI 兼容**：设置 `OPENAI_IMAGE_API_KEY` 即可启用。自定义中转站填写 API 根地址（例如 `https://relay.example.com/v1`，不含 `/images`）和模型名。要将其设为默认渠道，可设 `IMAGE_GENERATION_PROVIDER=openai-compatible`。自定义模型仍须兼容所用的 Images 接口和请求参数。
- **可选 ComfyUI**：为 Qwen/Krea 提供自管的 GPU 服务。配置 `QWEN_LOCAL_SSH_HOST` 为已验证的 SSH 主机别名，并在该主机启动带有对应工作流和权重的 ComfyUI。默认转发远端 8188 到本机回环 18488；可用 `QWEN_LOCAL_REMOTE_PORT` 修改远端端口。默认通过 ComfyUI API 读取结果；已有兼容远端助手的安装可用 `QWEN_LOCAL_OUTPUT_HELPER_CMD` 指定其命令，以继续找回和清理远端输出。
