<p align="center">
  <img src="public/logo.svg" alt="Banana Gallery Logo" width="96" height="96" />
</p>

<h1 align="center">Banana Gallery</h1>

<p align="center">
  <strong>网页看图挑片，AI Agent 批量出图 —— 你的本地生图工作台</strong><br/>
  每张成图自带 <code>#作品编号</code>、原始提示词与有序参考图，网页和你的 Agent 共用同一份本地图库。
</p>

---

## 为什么做 Banana Gallery？

普通 AI 生图网页用久了，通常会卡在两件事上：
一是**图和提示词很快散架**——过两天翻到一张满意的成图，却怎么也想不起当时用了哪个模型、改了哪句词、塞了哪几张参考图、顺序是什么；
二是**反复改图太累**——每次微调一句提示词、换件衣服、换个表情或姿势，都得手动在网页里一遍遍重新传图、贴词、点生成。

Banana Gallery 把看图和跑图拆开配合，两边共用同一份本地图库：

- **每张图都有可追溯的 `#作品编号`**：提示词、模型参数和当时传入的**有序参考图**全部跟成图绑在一起留档。以后想基于某张图微调，只要带上它的 `#作品编号`，不用翻聊天记录，你或你的 Agent 都能把当时的完整输入原封不动调出来继续改。
- **网页端专注看图与沉淀配方**：像本地相册一样逛图、收藏、打标签、多图并排对比；把跑出来的满意提示词一键存成可复用配方，也能整理常用参考图和参考图组合。
- **Agent 端负责批量出图（内置 CLI + 标准 Skill）**：仓库自带跨平台命令行和 [Agent Skill](skills/banana-gallery/SKILL.md)，Claude Code、Codex、Cursor、Antigravity 装上就能直接驱动后端：
  - 在你的**提示词仓库**里写完提示词，直接让 Agent 提交生图；看图不满意，按 `#作品编号` 让它继续迭代；
  - 在你的**服装 / 表情 / 姿势素材库**里，让 Agent 挑好参考图带过来，一键跑出「多套提示词 × 多组参考图」的批量矩阵（支持断点续投，不重复扣费）；
  - 也可以接入你自己的其他自动化工作流，所有成图都会自动回到同一个网页图库里等你验收。
- **本地自托管，免配数据库**：纯本地 JSON + 磁盘原图；同时支持 **Google Gemini（Vertex AI 服务账号凭证 / API Key）** 与 **OpenAI / 任意兼容中转站**，并内置**免费演示渠道**，装完不填 Key 就能先跑通网页和命令行生图。

---

## 快速开始（Windows / macOS / Linux 通用）

### 环境要求

- **Node.js 24 LTS**（推荐；使用 Node 22 时至少需要 22.13）
- **Python 3.10+**（仅使用 Agent CLI / Skill 时需要；只依赖标准库，无需 `pip install`）

### 本地启动

```bash
git clone https://github.com/nightylove99/banana-gallery.git
cd banana-gallery
npm install
npm run build
npm start
```

打开浏览器访问 `http://127.0.0.1:3333`。首次启动默认开启**免费演示渠道（`banana-demo-v1`）**，不填 Key 就能直接点生成体验，确认没问题后再配真实渠道。

随时可以运行一键自检查看环境与已启用渠道：

```bash
npm run doctor
```

Windows 安装 Node.js 后请重新打开终端。若 PowerShell 阻止执行 `npm.ps1`，用 `npm.cmd` 代替 `npm`，或在 CMD 里运行上面的命令；无需修改执行策略。

---

## 懒得自己配？直接交给你的 Agent 帮装

如果你正在使用 Claude Code、Codex、Cursor、Antigravity 等本地 Agent，可以直接把本仓库链接发给它并说：

> 帮我把 Banana Gallery 克隆到本地并安装好：按 README 运行 `npm install`、`npm run build` 和 `npm run doctor`，用内置的 `demo` 渠道（`banana-demo-v1`）把网页启动和 CLI 生图自检跑通，再把仓库里的 `skills/banana-gallery` 装成我的 Skill。跑通后告诉我怎么在网页设置里填写生图 API Key。

---

## 配置真实生图渠道

启动后，打开**本机网页 → 设置 → 生图渠道与默认参数**：

- **Google Gemini**：填写 Gemini API Key，或上传 Vertex AI 服务账号 JSON，并按需修改区域（默认 `global`）。两者同时配置时优先使用服务账号。
- **OpenAI / 自定义中转站**：填写 Base URL、API Key 和模型名。OpenAI 官方地址默认为 `https://api.openai.com/v1`。

**保存即生效，不需要改 `.env` 或重启。** 然后可以在同一张卡片下方选择新建生图的默认模型、比例和分辨率／质量。远程网页只能查看脱敏状态，请从本机入口填写或清除凭据。

网页凭据只保存在服务器本机数据目录，不包含在图库备份中；迁移到另一台机器时需要重新配置。已有环境变量配置仍可用；网页覆盖某项后，清除该项即可回退到环境变量。

### 进阶配置（代理、端口、外网访问、其他渠道）

需要设置代理、端口、Cloudflare Access、Agent 访问令牌，或启用 Seedream（火山方舟）、通义／可灵（阿里云百炼）、通用 ComfyUI 等渠道时，复制 `.env.example` 为 `.env`，按模板注释填写并重启服务。模板中也保留 Google 和 OpenAI 兼容渠道的环境变量写法，便于无界面部署。

```bash
# macOS / Linux
cp .env.example .env

# Windows PowerShell
Copy-Item .env.example .env
```

不要把 `.env` 或本机凭据文件提交到 Git。

---

## 网页端常用玩法

装好并打开网页后，除了直接点生成和逛图库，下面这几个工作流和功能最容易提效：

- **「作品」与「配方」分工**：日常跑出来的成图默认进入「作品」，用来留档每次尝试；挑出满意的提示词后，再一键存成「配方」当作可复用模板（网页里可直接套用，外部 Agent 也能检索配方库找灵感）。
- **多标签独立草稿**：另开新的生图标签页会自动建立独立草稿，互不覆盖；未提交的提示词和选好的参考图保存在浏览器本地，刷新或切页不会丢失。
- **参考图库与组合**：常用的人物、画风或构图参考图可以在「设置 → 管理参考图库与组合」或生成页中沉淀成素材库与组合，生图时一键整组调用；每张参考图都支持附带文字说明并调整顺序。
- **任务抽屉、断线恢复与自动下载**：完整任务记录收在右侧滑出抽屉中，支持按状态和关键词筛选。遇到断线或超时进入「待确认」时，系统不会盲目重投扣费，可直接续拉原结果或按冻结原输入重试；开启「新成图自动下载」后，多开标签页也不会重复下载。
- **纯净看图与快捷筛选**：图库默认只看图，悬停、聚焦或点击展开操作栏，大图详情与对比弹窗均支持键盘左右方向键切图；搜索栏内置「待整理（未命名 / 无标签 / 最近 7 天）」及来源、模型、日期、多标签组合筛选。
- **多选批量整理与并排对比**：点击顶部「多选」进入整理模式，除了批量打标签、转配方、加入收藏夹和打包导出 ZIP，还支持**选中 2–4 张并排对比**、**选中单张后一键拉出所有同提示词候选图**以及**批量预览命名与标签建议**；误删内容会先进入回收站，可随时恢复。
- **个性化默认设置**：在「设置」页可固定默认模型、比例、分辨率/质量、常用模型排序，以及图库的默认展示密度与构图方式（填充裁切 / 完整构图）。
- **顺手收图（Gemini 网页扩展）**：如果你平时也在 Gemini 网页版直接画图，可加载仓库自带的浏览器扩展（见 [doc/gemini-extension.md](doc/gemini-extension.md)），一键把网页成图、提示词和参考图收入同一个本地图库。

---

## 接入外部 Agent（CLI + Skill）

仓库内置了标准 Agent Skill：`skills/banana-gallery/SKILL.md`。推荐用**链接**方式安装到你的 Agent Skills 目录，这样以后拉取主仓库更新时 Skill 会自动同步，不会与主程序脱节：

```bash
# macOS / Linux（推荐：软链接，随仓库自动更新）
ln -s /绝对路径/banana-gallery/skills/banana-gallery ~/.your-agent/skills/banana-gallery

# Windows CMD（推荐：目录联接，无需管理员权限，随仓库自动更新）
if not exist "%USERPROFILE%\.your-agent\skills" mkdir "%USERPROFILE%\.your-agent\skills"
mklink /J "%USERPROFILE%\.your-agent\skills\banana-gallery" "C:\绝对路径\banana-gallery\skills\banana-gallery"
```

`mklink` 是 CMD 内置命令；在 PowerShell 中用 `cmd /c mklink /J ...`，并先创建联接的父目录。联接位置不能已经有同名文件夹。

如果你使用的是**直接复制**方式安装 Skill，以后运行 `npm run update` 时如看到 Skill 变动提醒，重新复制覆盖一次 `skills/banana-gallery` 即可。

### 常用命令示例

```bash
# 检查服务与可用模型
python3 scripts/banana-gallery.py ensure
python3 scripts/banana-gallery.py models --available-only

# 提交生图并等待入库拿到 #作品编号
python3 scripts/banana-gallery.py generate --key shot-01 --prompt-file prompt.txt
python3 scripts/banana-gallery.py wait TASK_ID --no-download

# 基于已有作品编号继续迭代提示词（自动继承原模型和参考图）
python3 scripts/banana-gallery.py iterate --from "#作品编号" --key shot-02 --prompt-file revised.txt
```

- **外部参考图 / 批量矩阵**：Agent 在素材目录挑好图后，单张直接用 `--reference` 传入，多组组合用 `batch --manifest` 跑断点续投矩阵（示例见 [skills/banana-gallery/examples/batch-matrix.json](skills/banana-gallery/examples/batch-matrix.json)）。
- 把 `TASK_ID` 换成 `generate` 返回的 `id`。免费演示模型不接受参考图。
- **Windows 下调用 CLI**：先运行 `npm start`，再把命令里的 `python3` 换成 `py -3`；没有 `py` 启动器但 `python --version` 显示 3.10+ 时，可以用 `python`。路径有空格时加双引号。

### 跨机调用与访问令牌

本机默认仅监听 `127.0.0.1:3333` 免登使用。如果需要从另一台机器让 Agent 调用，或在 `.env` 中启用接口令牌鉴权，可以设置：

```env
BANANA_GALLERY_API_TOKEN=一个随机高强度令牌
```

外部 Agent 通过环境变量 `BANANA_GALLERY_URL` 和 `BANANA_GALLERY_TOKEN` 携带 Bearer 令牌调用 `/api/v1`。该令牌默认只开放查图、上传参考图、提交/查询任务和保存配方，**禁止**删除作品、清空回收站、管理备份或读取服务器本地路径。

完整接口说明见 [doc/api-v1.md](doc/api-v1.md)。

---

## 如何更新

你的 `.env` 配置和图库数据（`gallery-data.json`、`public/images/`、`public/references/`）均在 `.gitignore` 中，正常更新不会覆盖个人数据。大版本升级前建议先在网页「设置 → 存储与备份」点一次本机备份。

### 方式一：一键命令更新

确认没有正在排队或执行的生图任务后，在仓库根目录运行：

```bash
npm run update
```

脚本会自动检查工作区是否干净、本地队列是否空闲，然后执行 `git pull --ff-only`、按需更新依赖并重新构建；如果本次更新改动了 Agent Skill，会明确提醒复制安装的用户同步。完成后重启 `npm start`（或 `./gallery.sh restart`）即可。

也可以随时在网页 **「设置 → 版本与更新」** 中手动点击 **「检查更新」** 查看 GitHub 是否有新版本（纯手动触发，不会后台自动联网）。

### 方式二：交给你的 Agent 帮更新

直接把下面这句话发给你的 Agent：

> 帮我把本地的 Banana Gallery 更新到最新版本：先确认没有正在执行的生图任务，运行 `npm run update`；如果提示 Skill 有变动且我当初是复制安装的，顺手帮我同步 `skills/banana-gallery`，最后重启服务并告诉我新版本号。

---

## 数据、备份与安全边界

- **数据位置**：默认保存在仓库根目录的 `gallery-data.json`、`public/images/` 和 `public/references/`（均已加入 `.gitignore`）；也可以通过 `BANANA_GALLERY_DATA_DIR` 指定到仓库外的独立目录。
- **备份与恢复**：在网页「设置」页可一键创建和校验本机备份，也可运行 `npx tsx scripts/gallery-backup.ts`。
- **数据流向**：只有在调用云端渠道时，提示词和参考图才会发往你配置的云厂商或中转站；使用 `demo` 渠道不会发起任何外网请求。
- **默认安全限制**：
  - `AUTH_MODE=local` 强制只允许监听回环地址（`127.0.0.1` / `::1`），避免无鉴权暴露到局域网或公网；**切勿用 Nginx / Caddy / Tunnel 等反向代理将本地免登端口直接暴露到公网**；
  - 服务端本地路径导入默认关闭；
  - 如需外网远程访问个人实例，可参考 [doc/gallery-local.md](doc/gallery-local.md) 配合 Cloudflare Access 使用。

---

## 适用范围

- **定位**：个人单机自托管（本地单端口运行，不包含多用户注册或团队计费分摊）。
- **主力渠道**：Google Gemini、通用 OpenAI 兼容 / 自定义中转站、内置免费演示渠道。
- **可选扩展**：Windows 独立打包脚本（[doc/windows-local.md](doc/windows-local.md)）、Gemini 网页捕获扩展（[doc/gemini-extension.md](doc/gemini-extension.md)）、Cloudflare Access 远程入口。

---

## 开发与校验

```bash
npm run dev:all              # 同时启动后端与 Vite 前端热更新
npm run typecheck            # 前端 TypeScript 类型检查
npm run test:contracts       # 后端 TypeScript 类型契约检查
npm run lint                 # ESLint 检查
npm test                     # 全部 JS/TS 单元与集成测试
npm run test:gallery-client  # Python CLI 单元测试与契约测试
npm run build                # 构建单端口生产前端
```

## 开源协议

本项目基于 [MIT License](LICENSE) 开源。发现安全问题请勿在公开 Issue 披露，详见 [SECURITY.md](SECURITY.md)。
