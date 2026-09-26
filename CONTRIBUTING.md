# 参与贡献

感谢你有兴趣改进这个项目。它是个人维护的本地工具，规模不大，所以下面的约定都很短。

## 环境要求

| 项 | 要求 |
| --- | --- |
| Node | **≥ 22.18**（服务端直接用 Node 原生类型剥离运行 `.ts`）。`.nvmrc` 固定了 `22.22.3`，`nvm use` 即可 |
| git | 必须。扫描、状态采集、分支管理都调用你本机的 git |
| 系统 | macOS（开发环境）、Linux、Windows 任一。**Windows 与 Linux 尚未实测**，欢迎反馈问题 |

## 起步

```bash
git clone <this-repo>
cd Gitventory
npm install
npm run dev
```

前端在 http://localhost:5173（带热更新，`/api` 代理到 8787），服务端在 8787。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 并行拉起前后端 |
| `npm run lint` / `npm run typecheck` | 代码检查（服务端 + 前端） |
| `npm run build` | 构建前端到 `web/dist` |
| `npm run smoke` | 冒烟自检：起一次真实服务 + 建临时仓库，验证扫描与采集链路 |
| `npm start` | 只起服务端；`web/dist` 存在时由同一端口托管前端 |

## 提交 PR 前

```bash
npm run lint && npm run typecheck && npm run build && npm run smoke
```

这四条必须全过（CI 会在 macOS / Linux / Windows 上各跑一遍，含 `smoke`）。
如果你的改动影响了运行行为，请顺手在 `CHANGELOG.md` 的 `[未发布]` 下补一条。

## 目录与约定

```
server/   Express 5 + TypeScript（Node 原生跑 TS，无构建产物）
web/      Vite + Vue 3 + Element Plus + Pinia
config/   本地配置模板（当前只有「打开方式」）
scripts/  开发启动与自检脚本
docs/     截图等文档资源
```

前后端共享的类型与常量**只写一份**，放在 `server/src/shared/`，前端通过 Vite 别名 `@shared` 引用同一份源码。
不要在两处各声明一套枚举 —— 这类漂移不会被编译器抓到。

几条来自实际踩坑的硬约束，改动相关代码前请读一遍：

| 约束 | 原因 |
| --- | --- |
| 不硬编码私有信息（内网 host、个人绝对路径） | 自建 Git 实例用 `GITVENTORY_SELF_HOSTED_HOSTS`，外部应用用 `config/open-targets.json`。曾有一个公司内网 IP 被写进 `platform.service.ts`，公开仓库时才发现 |
| 平台差异要**显式声明可用性 + 原因** | 非 macOS 上曾有「按钮亮着、点了必然 501」的体验。现在的口径是：不可用就禁用，并把原因（缺该平台命令 / 未装应用 / 命令不在 PATH）透给前端 |
| 错误文案必须是人话 | git 的英文输出经 `server/src/utils/git-error-text.ts` 映射成中文，**未命中的原样透出**（不丢信息）。前端一律读 `error.response.data.message`，否则用户只看到 `Request failed with status code 400` |
| 不要预留没人用的灵活性 | 配置项、抽象层、可选参数都需要第二个调用方来证明自己。宁可等真需求出现再加 |
| 注释写「为什么」，不写「做了什么」 | 代码已经说明做了什么；注释用来留住当时不知道就会踩第二次的结论 |

## 提交信息

用中文，Conventional 前缀，正文写清**为什么改**与**怎么验证**：

```
fix: 分支名含中文时被错误拒绝

isSafeRef 原本是 ASCII 白名单，实测 354 个分支引用里有 91 条含中文。
改为对齐 git 自身的 ref 规则（中文放行，选项注入与非法形态照旧拒绝）。

验证：真实仓库中文分支读提交 200；非法名 -x / foo..bar / foo bar 仍被 400 拒绝。
```

前缀用：`feat` / `fix` / `docs` / `chore` / `ci` / `refactor` / `test`。
一个 PR 做一件事；纯格式调整不必单开 PR，跟着相关改动走即可。

## 关于界面截图

改动 UI 时请附截图 —— 但**只能用演示数据**。这个工具扫的是本机仓库，截图里出现真实仓库名/路径就等于把你的目录结构公开了。
`docs/screenshots/` 下现有的三张图就是用临时目录里的假仓库渲染的。

## 语言

项目现状是**中文**：UI 文案、文档、提交信息、代码注释都是中文。
用英文写 issue 或 PR 也可以，维护者会在合并时统一措辞，不用为此纠结。

## 安全问题

不要在公开 issue 里贴 token、内网地址或可复现的攻击细节 —— 见 [SECURITY.md](./SECURITY.md)。

## 许可

本项目以 MIT 发布。你提交的贡献将按同一许可（MIT）授权。
