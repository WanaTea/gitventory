# 常见 IDE / 终端路径（macOS · Windows）

给两件事用：

1. **手工配 `config/open-targets.json`** 时的路径参照；
2. 作为**提示词底料** —— 让 AI 照着扫一遍你的机器，直接产出配置。

> ⚠️ **配置只认绝对路径与 `~`**：`expandHome()` 只展开 `~/`、`~\`，
> **不解析 `%LOCALAPPDATA%`、`$HOME` 这类环境变量**。所以配置里必须写展开后的真实路径。
> 下表左列给的是「环境变量写法」（便于你对照），配置时请替换成真实路径。

---

## 一、提示词（可直接复制给 AI 用）

```text
帮我为 Gitventory 生成 config/open-targets.json。

1. 先判断我在哪个系统（macOS / Windows）。
2. 按下面的候选路径，用「文件/目录是否真实存在」逐个检查，只保留真实存在的项；
   不存在的直接丢弃，不要写进配置。
3. 每个目标形如：
   { "id": "...", "label": "...", "labels": { "<平台>": "..." },
     "commands": { "<平台>": ["<命令名或绝对路径>"] } }
   命令优先写 PATH 上的命令名；PATH 上没有就写绝对路径（本项目支持绝对路径直判可用）。
4. Windows 路径在 JSON 里反斜杠要转义成 \\（例：C:\\Users\\me\\AppData\\Local\\...）。
5. 不确定的路径不要编造，单独列一节「待实测」告诉我，我去确认。
6. 输出完整 JSON，并附一张「保留了什么 / 丢了什么 / 待实测什么」的清单。
```

---

## 二、macOS

| 类别 | 应用 | 路径 / 命令 | 置信 |
| --- | --- | --- | --- |
| 编辑器 | VS Code | `/Applications/Visual Studio Code.app`（命令 `code`） | 高 |
| 编辑器 | VS Code Insiders | `/Applications/Visual Studio Code - Insiders.app` | 高 |
| 编辑器 | Cursor | `/Applications/Cursor.app` | 高 |
| 编辑器 | Zed | `/Applications/Zed.app` | 高 |
| 编辑器 | Sublime Text | `/Applications/Sublime Text.app`（命令 `subl`） | 高 |
| 编辑器 | Nova | `/Applications/Nova.app` | 高 |
| 编辑器 | BBEdit | `/Applications/BBEdit.app` | 高 |
| IDE | IntelliJ IDEA | `/Applications/IntelliJ IDEA.app`（CE 加 ` CE`） | 高 |
| IDE | WebStorm | `/Applications/WebStorm.app` | 高 |
| IDE | PyCharm | `/Applications/PyCharm.app`（CE 为 `PyCharm CE.app`） | 高 |
| IDE | GoLand / CLion / Rider / PhpStorm / DataGrip / RustRover | `/Applications/<产品名>.app` | 高 |
| IDE | Android Studio | `/Applications/Android Studio.app` | 高 |
| IDE | Xcode | `/Applications/Xcode.app` | 高 |
| Terminal | iTerm2 | `/Applications/iTerm.app` | 高 |
| Terminal | Warp | `/Applications/Warp.app` | 高 |
| Terminal | Alacritty | `/Applications/Alacritty.app` | 高 |
| Terminal | kitty | `/Applications/kitty.app` | 高 |
| Terminal | WezTerm | `/Applications/WezTerm.app` | 中 |
| Terminal | Tabby | `/Applications/Tabby.app` | 中 |
| Terminal | Ghostty | `/Applications/Ghostty.app` | 中 |
| Terminal | 系统终端 | `/System/Applications/Utilities/Terminal.app`（命令 `open -a Terminal`） | 高 |
| 文件管理 | Finder | 命令 `open` / `open -R` | 高 |
| 国内工具 | Trae | `/Applications/Trae.app` | 高 |
| 国内工具 | CodeBuddy CN | `/Applications/CodeBuddy CN.app` | 高 |

**macOS 的坑**：GUI 应用**不一定有 CLI**。`code` / `subl` 需要用户装过「Shell Command」才有；
所以本项目的 macOS 默认走 **bundle id + `open`**（见 `open-targets.service.ts` 注释），
比依赖 CLI 稳。要打开一个**目录**而不是文件，可用 `open -a <App>` 或 `open -b <bundleid>`。

---

## 三、Windows

| 类别 | 应用 | 路径 / 命令 | 置信 |
| --- | --- | --- | --- |
| 编辑器 | VS Code（用户级） | `%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe`（命令 `code`） | 高 |
| 编辑器 | VS Code（系统级） | `%ProgramFiles%\Microsoft VS Code\Code.exe` | 高 |
| 编辑器 | VS Code Insiders | `%LOCALAPPDATA%\Programs\Microsoft VS Code Insiders\Code - Insiders.exe` | 高 |
| 编辑器 | Cursor | `%LOCALAPPDATA%\Programs\cursor\Cursor.exe` | 中 |
| 编辑器 | Sublime Text | `%ProgramFiles%\Sublime Text\sublime_text.exe`（命令 `subl`） | 高 |
| 编辑器 | Notepad++ | `%ProgramFiles%\Notepad++\notepad++.exe` | 高 |
| IDE | IntelliJ IDEA（Toolbox） | `%LOCALAPPDATA%\JetBrains\Toolbox\apps\IDEA-U\ch-0\*\bin\idea64.exe` | 中 |
| IDE | IntelliJ IDEA（安装版） | `%ProgramFiles%\JetBrains\IntelliJ IDEA\bin\idea64.exe` | 中 |
| IDE | 其它 JetBrains | `%ProgramFiles%\JetBrains\<产品>\bin\<产品>64.exe` | 中 |
| IDE | Android Studio | `%LOCALAPPDATA%\Programs\Android Studio\bin\studio64.exe` | 中 |
| Terminal | Windows Terminal | 命令 `wt`（Store 版位于 `%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe`） | 高 |
| Terminal | PowerShell 5 | `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` | 高 |
| Terminal | PowerShell 7 | `%ProgramFiles%\PowerShell\7\pwsh.exe` | 高 |
| Terminal | CMD | `%SystemRoot%\System32\cmd.exe` | 高 |
| Terminal | Git Bash | `%ProgramFiles%\Git\git-bash.exe`（`git-bash.exe --cd-to-home` 也可） | 高 |
| Terminal | Alacritty | `%ProgramFiles%\Alacritty\alacritty.exe` | 中 |
| Terminal | WezTerm | `%ProgramFiles%\WezTerm\wezterm-gui.exe` | 中 |
| Terminal | Tabby | `%LOCALAPPDATA%\Programs\Tabby\Tabby.exe` | 中 |
| 文件管理 | 资源管理器 | 命令 `explorer`（**成功也返回退出码 1**，配置里需要 `"ignoreExitCode": true`） | 高 |
| 国内工具 | Trae / CodeBuddy | **待实测** | 低 |

**Windows 的坑**：

1. **同名应用有两个安装位置**：用户级（`%LOCALAPPDATA%\Programs\...`，装的时候没要管理员权限）
   与系统级（`%ProgramFiles%\...`）。探测候选要把两个都列上。
2. **`explorer` 打开目录成功时退出码是 1** —— 不配 `ignoreExitCode` 会被当成失败。
   内置默认已经处理了这一点。
3. **`code` / `subl` 是 `.cmd` 而不是 `.exe`**：探测时要用 `PATHEXT`（`.COM;.EXE;.BAT;.CMD`）拼后缀，
   本项目 `resolveCommand()` 已按 `PATHEXT` 处理。
4. **Store / MSIX 版应用**（Windows Terminal 等）装在 `%LOCALAPPDATA%\Microsoft\WindowsApps`，
   是「执行别名」而非真实 exe，探测时要按命令名走 PATH，不要按固定路径判。

---

## 四、怎么落到配置里

```bash
cp config/open-targets.example.json config/open-targets.json
```

要点：

- **`id` 与内置项同名 = 覆盖**（只写要改的那几项即可，不必抄整份）
- 想彻底接管（删掉用不上的内置项）→ 加 `"replaceDefaults": true`
- 平台视角：`commands` / `apps` / `labels` 都是**按平台分键**的对象，缺哪个平台就等于该平台不支持
- 改完**最多 30 秒生效**（服务端 30s TTL 缓存），不用重启
- **写坏了不会崩**：解析失败会退回内置默认，并把原因打进启动日志

## 五、待实测（别照抄）

下面这些**没有在真机上确认过**，按项目一贯口径「不写猜的值」，等你或贡献者实测后再补：

- Trae / CodeBuddy 的 Windows 安装路径与可执行文件名
- Cursor Windows 的目录名大小写（`cursor` / `Cursor`）
- JetBrains Toolbox 在 Windows 下的版本目录形态（`ch-0\<build>\` 里的通配）
- WezTerm / Tabby / Ghostty 各平台路径随版本变动的情况

确认后请一并更新本文件，并把**已实测**的候选补进 `server/src/services/open-targets.service.ts` 的 `DEFAULT_TARGETS.apps`，
让用户开箱就有可用项。
