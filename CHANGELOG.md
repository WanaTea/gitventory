# 更新日志

记录本项目的显著变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

**1.0 之前接口仍可能调整**（配置项、API 响应字段），不兼容改动会在对应版本的 `Changed` 段写明。
新增条目请加在 `[未发布]` 下，发版时把它改名成版本号并补上日期。

## [未发布]

### 新增

- **扫描范围支持唤起系统的「选择文件夹」框**：不用手打路径了。由服务端进程弹系统原生对话框
  （macOS 的 Finder 面板、Windows 的资源管理器选择框、Linux 的 zenity 或 kdialog）——
  浏览器的目录选择 API 只给目录句柄、不给绝对路径，扫描用不了，所以这个框只能由本地服务来弹。
  用户在弹窗里取消**不算错误**；同时只允许一个弹窗，避免两个标签页各点一次叠出两个框。
- **扫描范围弹窗新增「让 AI 代劳」提示词**：本机真实的工作目录多半不在常见的 `~/code` 里，
  而是散在 IDE 与终端的「最近打开」记录中（VS Code 的 globalStorage、JetBrains 的
  recentProjects、shell 历史里的 `cd`）。内置一段提示词，交给 AI 就能翻出这些位置，
  并给出可直接粘贴的清单。

### 修复

- **扫描范围不接受 Windows 盘符路径**：前端校验写死了 `/` 与 `~` 前缀，`D:\develop\ai`
  被当成相对路径拒绝，而服务端 `isAbsolute()` 本来认它 —— 合法的输入被挡在客户端。
  改为跨平台判定（POSIX / Windows 盘符 / UNC / `~`），`expandHome` 同时接受 `~\` 写法，
  两处提示文案也改成跨平台口径。
- **选择文件夹时选中盘符根被判成非法路径**：`BrowseForFolder` 返回 `D:\`，削掉末尾斜杠后
  变成 `D:` —— 那是「驱动器相对路径」，`isAbsolute()` 与前端校验都不认。削尾现在保留盘符根。
- **Windows 上三处「起了进程却看不见效果」**：根因同为 `windowsHide: true`（等价
  `CREATE_NO_WINDOW`），被隐藏的不只是控制台，需要用户看见的窗口也一起消失：
  - `npm run dev` 直接报 `spawn EINVAL` 起不来 —— `npm.cmd` 是批处理脚本，不经 shell
    无法 `CreateProcess`，现与 `scripts/start.mjs` 对齐加 `shell`；
  - 「选择文件夹…」的 PowerShell 选择框不显示，进程却一直阻塞，之后每次点击都返回
    409「已经有一个文件夹选择框开着」—— 改用 PowerShell 自己的 `-WindowStyle Hidden`
    （控制台隐藏、窗口照常弹）并补 `-STA`；
  - 「在资源管理器中打开」窗口不显示，而 `explorer` 成功时退出码也是 1、又被
    `ignoreExitCode` 放行，表现为「提示成功、什么都没打开」。

  执行 git 命令处（`utils/exec-git.ts`）的 `windowsHide` 保留：git 没有界面，隐藏控制台是对的。

## [0.1.0] - 2026-09-26

首个公开版本：本机 git 仓库盘点 + 分支管理。本地优先，零凭据，不联网。

### 新增

- **一键启动**：`npm run launch` —— 检查 Node / git 版本、装依赖、构建前端、起服务并打开浏览器；
  做过的步骤会跳过，端口被占用时给出明确指引。
- **仓库清单**：扫描本机目录，找出含 `.git` 的仓库（深度 ≤ 5，跳过隐藏目录与 `node_modules`）。
  扫描根默认取「存在的常见目录」（`~/code`、`~/Projects`、`~/dev`、`~/Documents`、`~/Desktop` 等，
  全不存在则退回 home），也可在界面的「扫描范围」里就地修改并立即重扫。
- **平台识别**：GitHub / GitLab / Gitee / Codeup / CODING；自建 Git 实例通过
  `GITVENTORY_SELF_HOSTED_HOSTS` 声明，未识别的一律落到「其他」并展示原始 host。
- **状态盘点**：已跟踪改动数、未跟踪数、当前分支领先/落后、任一分支存在未推送提交、
  久未动阈值（`GITVENTORY_STALE_DAYS`，默认 90 天）。
- **未接入分类**：N1（无任何 remote）与 N2（有 remote 但存在本地独有提交），可与其它筛选叠加。
- **Git 分支管理**（双击任意行，或点操作列的 Git 图标）：本地/远程分支列表、切换分支、
  从远程签出、拉取、推送、批量删除分支（本地与远程）、撤销已跟踪文件的改动、分页查看提交记录。
- **用外部应用打开**：内置文件管理器 / VS Code / CodeBuddy CN / Trae / Warp，按平台解析命令
  （macOS 走 `open` + bundle id，Windows / Linux 走 PATH 上的命令）；
  可用 `config/open-targets.json` 覆盖或扩充（模板见 `config/open-targets.example.json`）。
- **清单页交互**：概览卡点击即筛选、多条件筛选（关键词 / 平台 / 连接状态 / 状态）、
  列显示与拖拽排序（本地持久化）、列头排序、图例。
- **两种运行形态**：`npm run dev`（并行拉起前后端，带热更新）与
  `npm run build && npm start`（express 单端口同时托管 API 与前端产物）。
- **配置**：环境变量或仓库根目录 `.env`（模板 `.env.example`）：`GITVENTORY_SCAN_ROOTS`、
  `GITVENTORY_SELF_HOSTED_HOSTS`、`PORT`、`GITVENTORY_STALE_DAYS`、`GITVENTORY_DATA_DIR`。
- **自检**：`npm run smoke` 起一次真实服务并断言扫描链路，CI 在三个平台各跑一遍。

### 变更

- **项目更名为 Gitventory**（原名 Github Manager）：本工具支持 GitHub / GitLab / Gitee / Codeup /
  CODING 五种平台，原名只提 GitHub 既不准确，也涉及 GitHub 商标在第三方项目名中的使用限制。
  更名发生在首次公开发布之前，没有已发布版本受影响。
- **环境变量前缀 `GHM_` → `GITVENTORY_`**：`GITVENTORY_SCAN_ROOTS`、`GITVENTORY_SELF_HOSTED_HOSTS`、
  `GITVENTORY_STALE_DAYS`、`GITVENTORY_DATA_DIR`（`PORT` 不变）。
- 默认数据目录 `~/.github-manager` → `~/.gitventory`；前端列设置的 localStorage 键同步改名
  （浏览器里已存的列显示 / 排序会重置一次）。
- 界面主题取自 DeepSeek Harness 的令牌体系：层次靠发丝边框与留白而非阴影，
  主操作近黑、强调色品牌蓝，语义色只以 10% 透明度做底。
- 「打开目标」由编译期常量改为运行期配置；不可用原因由服务端下发，与接口 501 的文案同源。

### 修复

- **分支名含中文时被错误拒绝（400）**，切换分支、查看提交、删除分支均受影响 —— 改为对齐
  git 自身的 ref 规则（中文放行，选项注入与非法形态照旧拒绝）。
- **未安装 git 时界面会安静地给出错误数据**（所有仓库被判成「未接入、无改动」）——
  现在启动日志、列表告警、首屏提示三处都会明示原因。
- 非 2xx 响应丢失服务端的中文原因，用户只看到 `Request failed with status code N`。
- 默认打开方式在非 macOS 上给出「点了必然失败」的按钮；接口与文案现已按平台判定。
- 端口被占用时抛原始堆栈（`EADDRINUSE`），现改为提示「可能已有一个实例在运行」。
