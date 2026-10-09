# Code Runner Pro

运行代码片段或整个文件，覆盖 50 多种语言，并且**支持 docx / exe / pdf 这类非文本文件**。

> 本项目是 [formulahendry/vscode-code-runner](https://github.com/formulahendry/vscode-code-runner)（作者 Jun Han，MIT）的 fork。
> **配置键沿用 `code-runner.*`**（已有配置零迁移），**命令 ID 独立为 `crun.*`**（可与原版共存，不会互相抢占）。
> English: [README.en.md](README.en.md)

## 相比原版多出来的能力

| 能力 | 说明 |
|---|---|
| **非文本文件** | docx / exe / pdf / xlsx 等也能运行。原版必须先 `openTextDocument`，二进制文件会让命令直接中断；本 fork 改成"能读内容就读，读不到就只用路径"，自定义编辑器（Office Viewer）里的文件同样可用 |
| **多命令** | 同一目标可配多条命令，点小三角时弹选择（上次执行的置顶）。值支持 `"命令"` / `["命令1","命令2"]` / `[{label, description, command}]` |
| **多段后缀** | `executorMapByFileExtension` 支持 `.x64.s` 这类多段后缀，**最长后缀优先**（`.x64.s` 赢过 `.s`），不区分大小写、不依赖书写顺序 |
| **Alt 多选区** | 原版只取主选区；本 fork 把所有非空选区**按文档顺序原样拼接**成一个临时文件 |
| **可配匹配顺序** | `matchOrder` 决定各匹配层的先后，默认"具体优先" |
| **诊断命令** | `解释当前文件是怎么被匹配的`（输出可直接贴进 Issue）、`查看 扩展名 → 语言 对照表` |
| **可观测性** | `showTempCode` 把临时文件内容打印到输出面板；`deleteTempFileAfterRun` 跑完删除临时文件 |
| **本地化** | 设置界面与命令面板跟随 VS Code 的显示语言（`package.nls*.json`） |
| **无遥测** | 上游会把运行事件上报到作者自己的 Application Insights 账号，本 fork 已彻底移除 |

## 基本用法

| 想做的事 | 怎么做 |
|---|---|
| 运行整个文件 | 编辑器右上角的 ▶，或 `Ctrl+Alt+N` |
| 只运行选中片段 | 选中后同样操作；**Alt 多选**可以拼多段 |
| 运行资源管理器里的文件 | 在文件上右键 → `Run Code` |
| 换个语言运行当前文件 | 命令面板 → `按语言运行` |
| 停止 | `Ctrl+Alt+M` |
| 搞清楚"为什么跑了这条命令" | 命令面板 → `解释当前文件是怎么被匹配的` |

### 多选区运行

用 Alt 点击 / Alt 拖选选中多处，然后运行：所有非空选区会**按文档顺序原样拼接**成一个临时文件，**不做任何上下文注入**。需要 `#include`、命名空间、前面的类型定义时，把它们一起选上就行 —— 由你决定拼接什么，比工具猜依赖可靠得多。

`multiSelectionMode` 设为 `primary` 可退回原版行为（只用主选区）。

### 选区运行的临时文件

- 后缀**完全沿用原文件后缀**（无后缀的文件就生成无后缀的临时文件），因此临时文件与原文件行为一致：原文件跑不了，临时文件也跑不了，那说明配置有问题，直接修配置。
- `temporaryFileName` 控制基名（默认 `tempCodeRunnerFile`）。
- `deleteTempFileAfterRun`（默认开）跑完删除；终端模式下会在同一个 shell 里紧接着追加一条删除命令。
- `showTempCode` 打开后会把生成内容打印到 `Code Runner Pro` 输出面板，便于核对。

## 匹配顺序

前一步命中就停止，默认按 **"具体优先"** 排列：

```
shebang → glob → extension → language → default
```

| 步骤 | 匹配依据 | 配置来源 | 适合管什么 |
|---|---|---|---|
| `shebang` | 文件首行 `#!` | — | 自带解释器的脚本 |
| `glob` | 完整文件名（micromatch） | `executorMapByGlob` | `Makefile`、`pom.xml`、`*.test.py` |
| `extension` | 文件名末尾后缀（最长优先） | `executorMapByFileExtension` | 同语言的不同变体（`.x64.s` / `.mips.s` / `.s`） |
| `language` | VS Code 认定的语言 id | `executorMap` | 一种语言统一怎么跑（粒度最粗） |
| `default` | 兜底语言 | `executorMap[defaultLanguage]` | 都没命中时 |

`matchOrder` 就是**一个字符串**，用逗号或空格分隔，可以整体改写；**留空表示使用默认顺序**：

```jsonc
// 默认（具体优先）
"code-runner.matchOrder": "shebang, glob, extension, language, default"

// 回到上游语义（语言先于后缀）
"code-runner.matchOrder": "shebang, glob, language, extension, default"
```

未列出的步骤会自动按默认顺序补在末尾；非法项与重复项被忽略。不确定某个文件走了哪一步？跑一次 `解释当前文件是怎么被匹配的`。

> 典型坑：把 `.asm` 和 `.x64.s` 都关联到 `assembly` 语言后，`executorMap["assembly"]` 会把 `.x64.s` 截胡 —— 让 `extension` 排在 `language` 前面（默认如此）即可。

## 配置

### 三张表

| 配置 | 维度 | 说明 |
|---|---|---|
| `executorMap` | 语言 id | 与上游一致；**值也可以写成数组**来实现多命令 |
| `executorMapByFileExtension` | 文件后缀 | 支持多段后缀，最长后缀优先 |
| `executorMapByGlob` | 文件名 glob | micromatch，第一个命中生效（具体模式写前面） |

### 多命令

```jsonc
"code-runner.executorMapByFileExtension": {
  ".docx": [
    { "label": "转 Markdown", "description": "同目录", "command": "pandoc $fullFileName -o $fileNameWithoutExt.md" },
    { "label": "转 PDF", "description": "soffice", "command": "soffice --convert-to pdf $fullFileName" }
  ]
}
```

命中多条时的行为由 `multiActionBehavior` 决定：`pick`（默认，弹选择且上次的置顶）、`last`（直接用上次）、`first`（直接用第一条）。

### 变量

`$fileName` `$fileNameWithoutExt` `$fullFileName` `$dir` `$dirWithoutTrailingSlash` `$workspaceRoot` `$pythonPath` `$driveLetter`

（与原版一致；`$dir`、`$dirWithoutTrailingSlash`、`$fullFileName` 会自动加引号。）

### 常用配置

全部 26 个配置项的说明都能在 VS Code 设置里看到（跟随显示语言）。常见几个：

| 配置 | 默认 | 说明 |
|---|---|---|
| `runInTerminal` | false | 在集成终端里运行（而不是输出面板） |
| `fileDirectoryAsCwd` | false | 以文件所在目录为工作目录 |
| `saveFileBeforeRun` | false | 运行前保存当前文件 |
| `clearPreviousOutput` | false | 每次运行前清空上一次输出 |
| `respectShebang` | true | 识别 shebang 并用作命令 |

## 与上游原版的兼容性

| 层 | 做法 | 结果 |
|---|---|---|
| 配置 | 共用 `code-runner.*` | 两边配置互通，零迁移 |
| 命令 | 主 ID `crun.*`；**原版未安装或已禁用时**额外注册 `code-runner.*` 别名 | 你自己绑的键位、`tasks.json`、脚本里的 `code-runner.run` 依旧可用；共存也不互相抢注 |
| 提示 | 检测到原版仍启用时提示一次 | 避免编辑器右上角出现两个一样的运行按钮 |

## 支持的语言

C, C++, Java, JavaScript, PHP, Python, Perl, Ruby, Go, Lua, Groovy, PowerShell, BAT/CMD, BASH/SH, F#, C#, VBScript, TypeScript, CoffeeScript, Scala, Swift, Julia, Crystal, OCaml, R, AppleScript, Elixir, VB.NET, Clojure, Haxe, Objective-C, Rust, Racket, Scheme, AutoHotkey, AutoIt, Kotlin, Dart, Free Pascal, Haskell, Nim, D, Lisp, Kit, V, SCSS, Sass, CUDA, Less, Fortran, Standard ML, Zig, Mojo, Erlang, Gleam …以及自定义命令。

## 致谢与许可

- 上游项目：[formulahendry/vscode-code-runner](https://github.com/formulahendry/vscode-code-runner)，作者 Jun Han，MIT 许可。
- 本 fork 同样以 MIT 许可发布；上游的版权声明保留在 `LICENSE` 中。
- 图标为本项目自制，不使用上游的品牌图形。
