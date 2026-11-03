# dpsk-bridge 0.5.0 使用参考

## 1. 这份文档

本文是 dpsk-bridge 0.5.0 的完整中文参考，面向直接安装、使用或排查问题的人。上手步骤和最短示例在 [README.md](../README.md)（[中文版](../README.zh.md)）；本文补齐工作原理、全部命令与参数、并发与故障处理、dsv 按键、环境变量以及开发和发布流程。版本变化见 [CHANGELOG.md](../CHANGELOG.md)。

文中的行为以本仓库当前代码为准，参数、短别名和默认值以 `dsb <命令> --help` 的输出为准；两者不一致时，先按 `--help` 和 `lib/cli.mjs` 修正文档。命令、参数名、事件名和代码保持英文。

本文要求 Node.js ≥ 24.9，dsh ≥ 0.2.2-alpha.3。桥只读取 v4 格式的 dsh 会话日志；更高版本的日志会被发现，但会提示该格式尚未验证。

## 2. 工作原理

### 2.1 几个角色

- **宿主代理（host agent）**：能执行本地命令的编程助手，例如 Claude Code、Codex 或其他 agent。它负责理解用户需求、派单、在运行中回答问题、最终验收。
- **dsh（DeepSeek Harness）**：真正执行作业的运行时，用自己的模型会话读代码、改文件、跑命令。
- **dsb**：本项目的命令行工具和作业启动器。一个作业对应一个 `dsb` 进程；它保存作业记录、申请调度名额、启动 dsh 子进程，并保持双向连接。
- **dsv**：会话日志查看器，只读，不控制作业。
- **SDK**：dsh 的 `sdk` profile。桥通过标准输入输出上的逐行 JSON-RPC（一种基于 JSON 的远程调用协议）与它通信；每个作业有独立的子进程和连接。

dpsk-bridge 不是 MCP server。`--patch` 只是把 MCP 配置交给 dsh 加载；MCP 本身的权限、工具和错误仍由 dsh 处理。

### 2.2 一个作业从排队到结束

1. `dsb run` 读取 brief、patch 和图片，解析 `--cwd` 的真实路径和 Git 工作区根目录，检查 dsh 版本、时间上限、并发值和上下文阈值。
2. 生成作业 ID（UUID），在作业目录写入 `job.json`、`brief.md`、`prompt.txt`、空的报告和事件文件、心跳文件，并向 stdout 输出一条 `queued` 事件。
3. 调度器按 `--concurrency`、`--scope`、`--read-only`、`--resource` 申请名额。排队期间作业状态是 `queued`；拿到名额后进入 `starting`，写 `baseline.json`，然后启动 `node <dsh>/lib/bin.js --profile sdk`，按顺序附加 `--patch`。
4. 子进程启动后状态变为 `running`，记录 `childPid`，输出 `started` 事件。桥先发送 `initialize`（工作目录、provider、model、原生提问和审批能力），再发送 `session/prompt`，把 brief、追加的报告约定、范围说明和图片交给 dsh。
5. 桥循环等待 `session/wait`，同时每 100 毫秒检查一次 `inbox/`，把宿主排队的消息和回答送进 SDK。dsh 的会话事件会镜像到 `root.session.jsonl`，提问和审批会进入 `pendingRequests`。
6. 当 `session/wait` 返回且期间没有新消息时，状态进入 `finishing`：停止接收新输入，清空最后一次 inbox；如果这一轮不是 `completed`，作业会以失败结束；否则发送 `shutdown` 并等待子进程退出。
7. 桥把最后一条助手回复写入 `report.txt`，从回复前 10 行解析 `RESULT`，汇总根会话用量，写 `after.json`，释放调度预约，并把仍未送达的输入逐条记为 `input_rejected`。`dsb run` 最后输出一条 `finished` 事件并退出。

`run` 和 `retry` 会一直挂到作业结束，也是仅有的会调用模型的 `dsb` 命令。`wait`、`status`、`result`、`events`、`send`、`answer`、`cancel`、`unlock`、`review`、`stats` 只读写本地文件或队列。

### 2.3 提问和权限请求怎么回到宿主

dsh 需要宿主决定时，会在同一个 JSON-RPC 连接上发一个请求：

- `user-question/ask`：普通提问，`params.questions` 是问题数组，每项有自己的 `id`。
- `approval/request`：权限审批，要求宿主给出 `allowed-once`、`rejected` 或 `cancelled`。

桥收到后记录一条 `request` 事件，把请求放进 `job.pendingRequests`，并在 `dsb run` 的 stdout 上输出 `request`。普通提问通常带 dsh 提供的 `requestId`；如果请求没有 ID，桥也会生成一个。审批请求在 SDK 线上没有请求 ID，桥会生成一个稳定的本地 UUID，并写进该请求的 `params.requestId`，所以两种请求都能用 `dsb answer --request` 回答。

宿主用 `dsb answer` 把回答写进 `inbox/`；启动器在下一轮 drain 时校验回答，调用 SDK 的 `respond` 把结果直接回给 dsh，并记录 `input_delivered`。如果请求已经被 dsh 撤回，桥记录 `request_cancelled`；仍在队列里的回答会收到 `input_rejected`。旧版本需要的宿主插件和转发事件已经移除，0.5.0 直接走 dsh SDK。

### 2.4 作业目录里有什么

作业保存在 `$DSH_HOME/bridge/jobs/<ID>/`，`DSH_HOME` 默认是 `~/.dsh`。调度状态在 `$DSH_HOME/bridge/scheduler/state.json`。

| 文件或目录 | 内容 |
|---|---|
| `job.json` | v2 作业记录：路径、配置、补丁哈希、图片哈希、进程状态、PID、心跳、计数、验收、用量等 |
| `brief.md` | 原始 brief 的副本；`retry` 会比较它的哈希 |
| `prompt.txt` | 实际发给 dsh 的完整提示，含报告约定、范围说明、图片说明和作业标记 |
| `report.txt` | 最后一条助手回复的全文；作业没有正常完成时可能为空 |
| `stderr.log` | dsh 子进程的标准错误；收尾阶段的记录也会追加到这里 |
| `events.jsonl` | 逐行 JSON 事件，每行带 `time` 字段；`dsb events` 从这里读取 |
| `heartbeat` | 心跳文件，启动器每 5 秒更新一次修改时间 |
| `inbox/` | 等待送给 dsh 的消息和回答；文件名是时间戳加 UUID，最多 256 条 |
| `baseline.json` | 派单前的 `git status` 清单，只是记录，不是备份 |
| `after.json` | 作业结束后的 `git status` 清单 |
| `root.session.jsonl` | 根会话的镜像事件，用来汇总用量 |
| `feedback.md` | 只有 `retry` 创建的作业才有，保存返工反馈 |
| `cancel.request` | `dsb cancel` 写下的取消标记，启动器每 100 毫秒检查一次 |
| `context.reported` | `wait` 返回过 `context` 后写下的标记，保证每个作业只提醒一次 |

## 3. 安装、更新与卸载

### 3.1 前置条件

需要 Node.js ≥ 24.9、npm 和 Git。安装脚本是 Windows PowerShell 脚本；核心命令行在 Windows 和 Linux 上都有测试，但自动同步 skill 目前只支持 Windows。

dsh 需要 ≥ 0.2.2-alpha.3。安装脚本会在 `dsh` 命令缺失或版本过旧时安装锁定版本 `@deepseek-ai/dsh@0.2.2-alpha.3`，已经足够新时保持原样。

### 3.2 安装脚本与宿主预设

```powershell
git clone https://github.com/XiaoNetwork-Astral/dpsk-bridge.git
cd dpsk-bridge
.\scripts\install.ps1 -Target Claude
```

宿主预设集中写在 `scripts/host-presets.json`，新增宿主只需要改这个文件：

| `-Target` | 默认 skill 目录 | 归属清单 |
|---|---|---|
| `Claude` | `%USERPROFILE%\.claude\skills` | `installed-skills.txt` |
| `Codex` | `%USERPROFILE%\.agents\skills` | `installed-skills-codex.txt` |
| `Generic` | 无，必须给 `-SkillsDir` | `installed-skills-generic-{key}.txt` |

`Generic` 的 `-SkillsDir` 必须是绝对路径；键值由该路径转小写后的 SHA-256 前 16 位十六进制组成，所以同步和卸载都要用同一个路径。

脚本参数：

| 参数 | 含义 |
|---|---|
| `-Target <name>` | 必填，取 `Claude`、`Codex`、`Generic` 之一；一次只处理一个宿主 |
| `-SkillsDir <dir>` | 只对没有默认目录的预设有效，必须是绝对路径；`Claude`/`Codex` 不能带这个参数 |
| `-SyncOnly` | 只同步 skill：不安装依赖、不检查 dsh、不运行 `npm run check`、不执行 `npm link` |
| `-Uninstall` | 卸载该宿主的托管 skill 和归属记录；`Generic` 要带原来的 `-SkillsDir` |

不带 `-Target` 或目标未知时，脚本会报错并列出可用预设。

正常安装会依次做这些事：

1. 检查 Node.js 版本和 npm 全局前缀。
2. 运行 `npm ci --ignore-scripts --no-fund --no-audit`，安装锁定依赖。
3. 检查 `dsh --version`；缺失或低于 0.2.2-alpha.3 时安装锁定版本，然后再次校验。
4. 运行 `npm run check`。
5. 把 `skill/` 下的 skill 同步到目标宿主的 skill 目录，覆盖或删除托管文件前先备份。
6. 运行 `npm link --offline --ignore-scripts --package-lock=false --no-fund --no-audit`，验证 `dsb.cmd` 和 `dsv.cmd` 存在；不在 PATH 上时给出警告。

脚本本身不写 dsh 的登录信息，也不改 `~/.dsh/patches/` 里的补丁。因为命令是通过 `npm link` 指向当前检出的，装好后不要移动这个目录，并重新打开宿主会话，让宿主重新加载 skill。

### 3.3 手动安装

没有 PowerShell 时，可以手动完成同样的步骤：

```text
npm install -g @deepseek-ai/dsh@0.2.2-alpha.3
git clone https://github.com/XiaoNetwork-Astral/dpsk-bridge.git
cd dpsk-bridge
npm ci --ignore-scripts
npm link
```

然后把 `skill/deepseek-delegate/` 和 `skill/deepseek-mcp/` 两个目录复制到宿主加载 skill 的位置。非 Windows 平台不会自动同步 skill，`npm run sync-skills` 会打印警告，需要手动复制。

### 3.4 多宿主与卸载

需要多个宿主时，分别运行一次安装命令，例如：

```powershell
.\scripts\install.ps1 -Target Claude
.\scripts\install.ps1 -Target Codex
.\scripts\install.ps1 -Target Generic -SkillsDir "D:\agent\skills"
```

每个宿主有自己的归属清单和 `.host.json` 记录，但共享同一个 `dsb`/`dsv` 全局链接。卸载一个宿主时，用同样的目标加 `-Uninstall`；`Generic` 还要带原来的 `-SkillsDir`：

```powershell
.\scripts\install.ps1 -Target Claude -Uninstall
```

卸载会先检查所有要删除的 skill 路径，再逐个备份并删除，然后删除该宿主的归属清单和宿主记录。只要还有其他宿主的清单非空，共享的 `dsb`/`dsv` 命令就保留；最后一个宿主卸载时才检查并解除指向当前检出的全局链接。dsh、凭据、MCP 补丁和作业历史都不会被删除，备份也保留在 `~/.dpsk-bridge/backups/`。

### 3.5 skill 同步与备份

安装和 `-SyncOnly` 都会按文件比较源目录和目标目录：内容相同就跳过；不同就先备份再覆盖；源目录里已经删除的文件会先备份再从托管副本删除；不再包含在本仓库里的旧 skill 也会按归属清单删除。最后重写该宿主的 `installed-skills*.txt` 清单并更新 `.host.json`。

`npm run sync-skills` 会读取 `~/.dpsk-bridge/` 下的 `*.host.json`，对每个已登记宿主重新运行 `install.ps1 -SyncOnly`。它目前只在 Windows 上工作；遇到未知的宿主名会按 `Generic` 和记录中的目录处理。更新流程也会调用这个脚本。

备份放在 `~/.dpsk-bridge/backups/`，文件名由标签、时间和随机串组成，后缀是 `.bak`。如果托管路径上出现符号链接或联接点（reparse point），脚本会拒绝自动处理并提示手动检查，避免误删链接目标。

### 3.6 `dsv update` 自动更新

```text
dsv update --check           立即联网检查，不安装
dsv update                   检查并安装正式更新
dsv update --auto on         开启自动更新
dsv update --auto off        关闭自动更新（默认）
dsv update --recover --confirm-stopped
                             清理失败后，确认旧进程已退出再释放更新预约
```

全屏界面会在后台检查 GitHub 上最新的正式 Release。检查结果缓存 6 小时，界面每小时刷新一次，但联网检查最多每 6 小时一次。发现新版本时，顶栏显示 `Update <版本> available  u to install`，按 `u` 安装。检查失败只显示提示，不影响查看；`dsv ls`、`dsv show`、`dsv watch` 不联网检查。

设置非空的 `NO_UPDATE_NOTIFIER`、处于 CI 环境（`CI` 非空），或给全屏界面加 `--no-update-check`，都会关闭后台自动检查；手动 `dsv update` 仍然可用。`--auto on` 把设置写进 `~/.dpsk-bridge/settings.json`，默认关闭。

开启自动更新后，发现正式新版本时会先等桥接作业结束，再以独占预约进入调度系统。最多排队 60 秒，忙时保留提示，下一次界面刷新再试。更新只在以下条件都满足时进行：

- `dsv` 所在的安装目录是 Git 检出的根目录；
- `origin` 是 `package.json` 里 `repository.url` 指向的官方 GitHub 仓库；
- 工作区干净，没有未提交或未跟踪的文件；
- 当前 HEAD 是发布 tag 的祖先，可以快进；
- tag 指向的 `package.json` 名称是 `dpsk-bridge`，版本与 tag 一致；
- Release 是已发布、非草稿、非预发布的正式版本。

更新依次执行 `git merge --ff-only`、`npm ci --ignore-scripts --omit=dev`、`npm run check` 和 `npm run sync-skills`。完成后需要重新打开 `dsv` 和宿主会话。有本地修改或分叉时不会强制覆盖，更新暂停。

只有 Git 检出的安装目录支持自动更新；`install.ps1` 会用 `npm link` 建立 `dsb`/`dsv` 命令。失败会记录在 `~/.dpsk-bridge/update-state.json`；如果代码已经快进但安装失败，不会自动回滚，需要按记录修复依赖或检查。清理失败、独占预约没有释放时，先关闭原来的 `dsv`，确认记录里的所有进程都已退出，再运行 `dsv update --recover --confirm-stopped`。版本比较使用 npm 的 semver。

### 3.7 从旧项目名迁移

旧项目名是 `claude-deepseek-bridge`，旧状态目录是 `~/.claude-deepseek-bridge`。迁移步骤：

1. 先结束所有旧作业，确认没有残留进程。
2. 把 Git `origin` 改成新仓库地址，拉取当前代码。
3. 对每个宿主重新运行一次 `scripts/install.ps1`。
4. 重新打开宿主会话。

脚本会把旧的 `installed-skills*.txt` 清单复制到新状态目录一次（用 `legacy-manifests-migrated` 标记），删除指向旧包或旧 `.dsh/bin/dsv.mjs` 的命令包装，并在需要时解除旧包的全局链接。旧格式（v1）的作业记录 `dsb` 不再读取，`dsb stats` 会把它们计入 `legacyJobs`；历史文件不会被删除，会话日志仍可以用 `dsv` 查看。

## 4. dsb 命令参考

### 4.1 通用规则

`dsb` 只有一个入口：

```text
dsb <COMMAND> [OPTIONS]
dsb --help
dsb <COMMAND> --help
dsb help <COMMAND>
dsb --version
```

根命令的 `-h, --help` 打印命令列表和环境变量，`-V, --version` 打印版本；`dsb <COMMAND> --help` 打印该命令的参数和默认值。参数名用 kebab-case（短横线连接的小写单词），值占位符用大写，位置参数写作 `<ID>`。

长参数支持 `--name=value`，例如 `--brief=task.md`、`--time-limit=2700`、`--scope=src/a`。短别名只接受“别名 + 空格 + 值”的形式，例如 `-t 60`。带值的参数不能留空；带值的非可重复参数重复出现会报错；开关参数重复出现等同于一次；可重复参数（`--patch`、`--image`、`--scope`、`--resource`）会累加。

短别名如下：

| 短别名 | 长参数 | 用于 |
|---|---|---|
| `-h` | `--help` | 所有命令 |
| `-V` | `--version` | 仅根命令 |
| `-C` | `--cwd` | `run` |
| `-b` | `--brief` | `run` |
| `-p` | `--patch` | `run` |
| `-i` | `--image` | `run` |
| `-s` | `--scope` | `run` |
| `-t` | `--timeout` | `wait` |
| `-m` | `--message` | `send` |
| `-r` | `--request` | `answer` |
| `-a` | `--answer` | `answer` |
| `-f` | `--feedback` | `retry` |
| `-u` | `--user-ok` | `answer`、`retry` |

参数可以覆盖对应环境变量：

| 参数 | 环境变量 | 说明 |
|---|---|---|
| `--provider` | `DPSK_PROVIDER` | 参数优先 |
| `--model` | `DPSK_MODEL` | 参数优先 |
| `--concurrency` | `DPSK_CONCURRENCY` | 参数优先；多个启动器取最小上限 |
| `--context-limit` | `DPSK_CONTEXT_LIMIT` | 参数优先 |
| 无 | `DSH_HOME` | 作业根目录是 `$DSH_HOME/bridge` |

`DPSK_*` 系列只在 `dsb run` 建立作业时读取；`dsb retry` 沿用原作业记录的值，不重新读取它们。`DSH_HOME` 在每条命令定位作业目录时都会读取。

除 `--help`、`--version` 外，每个命令按行输出 JSON。出错时输出 `{"error":"..."}` 并以 1 退出。`run` 和 `retry` 会输出多行：`queued`、`started`、运行中的 `request`，最后是 `finished`。`run`/`retry` 只有在 `processState` 为 `completed` 且 `reportedResult` 为 `OK` 时才以 0 退出；`wait` 返回原因本身不改变退出码，作业成功与否仍要看结果。

作业 ID 是 `dsb run` 返回的完整 36 位 UUID；后续命令必须用完整 ID，不能只用前缀。ID 不合法时会提示使用完整 ID。

常用取值范围和限制：

| 项目 | 限制 |
|---|---|
| `--time-limit` | 大于 0，最多 86400 秒；包含排队时间 |
| `--timeout` | 1–3600 秒 |
| `--concurrency` | 1–256 的整数 |
| `--context-limit` | 正整数 |
| `--cursor` | 非负整数字节位置，必须是上一次 `events` 返回的游标 |
| `--limit` | 1–200 |
| brief、message、feedback、answer 文件 | UTF-8，最多 48000 字节，不能全是空白 |
| inbox 单条输入 | 序列化后最多 64 KiB；最多 256 条排队 |
| 图片 | 最多 20 张；首条消息的文字加 base64 后不超过 8 MiB |
| `--resource` | 每个名字最多 500 个字符，会去掉首尾空白并去重 |
| `--scope` | 相对工作区，解析后不能逃出工作区，也不能包含损坏的符号链接 |

> **0.5.0 的改名与移除**：`run --timeout` → `--time-limit`，`run --max-concurrent` → `--concurrency`，`send --message-file` → `--message`，`events --after` → `--cursor`，`unlock --confirmed-stopped` → `--confirm-stopped`（`dsv update --recover` 同名参数同样改名）；`--notify-cmd`、`install.cmd` 和旧的宿主插件转发已移除，`input_forwarded` 不再出现；提问和审批现在走 dsh SDK。

### 4.2 `dsb run`

启动一个作业，并一直挂到它结束。

```text
dsb run --brief <FILE> [OPTIONS]
```

| 参数 | 含义 | 默认值 |
|---|---|---|
| `-C, --cwd <DIR>` | 项目目录 | 当前目录（current directory） |
| `-b, --brief <FILE>` | 任务 brief（UTF-8），必填 | 无 |
| `-p, --patch <FILE>` | 加载一个 MCP patch；可重复 | 无 |
| `-i, --image <FILE>` | 附一张图片；可重复，最多 20 张 | 无 |
| `--time-limit <SECONDS>` | 作业时间上限（含排队），最大 86400 | `2700` |
| `--context-limit <TOKENS>` | 上下文提醒阈值；未给时读 `DPSK_CONTEXT_LIMIT` | `200000` |
| `--provider <ROUTE>` | 模型路由；未给时读 `DPSK_PROVIDER` | `deepseek-official` |
| `--model <NAME>` | 模型名；未给时读 `DPSK_MODEL` | `deepseek-flash` |
| `--concurrency <N>` | 最大并发作业数，1–256；未给时读 `DPSK_CONCURRENCY` | `8` |
| `-s, --scope <PATH>` | 协作写范围，不是沙箱；可重复 | 整个工作区 |
| `--read-only` | 声明只读任务；只读任务之间可以并行 | 关闭 |
| `--resource <NAME>` | 共享资源锁；可重复 | 无 |
| `--dsh-entry <FILE>` | 高级/调试：覆盖本机 dsh `lib/bin.js` 的查找 | 自动查找 |
| `-h, --help` | 打印帮助 | 无 |

`--brief`、`--message`、`--feedback`、`--answer` 都会去掉文件开头的 BOM，按 UTF-8 读取，超过 48000 字节或内容为空会拒绝。`--cwd` 必须是真实存在的目录；工作区根目录由 Git 决定，不是 Git 目录时就是 `--cwd` 本身。

图片按文件内容判断格式，只支持 JPEG、PNG、GIF、WebP，不看扩展名；最多 20 张。图片只随首条消息发送，`dsb send` 不能带图。图片文件在派单时和真正发送前都会检查哈希，被改动或删除会失败。

`--dsh-entry` 指向 dsh 的 `lib/bin.js`；桥会从它旁边的 `../package.json` 读取版本，低于 0.2.2-alpha.3 会拒绝。没有给这个参数时，桥会从 `PATH` 的目录里查找 `@deepseek-ai/dsh/lib/bin.js` 的常见安装位置。

输出要点：

- `{"event":"queued", ...}`：作业记录已建立，正在等调度名额。
- `{"event":"started", ...}`：dsh 子进程已经启动。
- `{"event":"request", "id":..., "requestId":..., "method":..., "params":...}`：需要宿主回答。
- 最后的 `{"event":"finished", ...}`：包含 `status` 字段、`error`、`report`（最多 6000 字节）、`reportTruncated`、`usage` 和 `verificationRequired`。

`run` 在前台运行时，宿主要保留进程句柄；如果宿主的命令工具在命令结束前拿不到输出，就把 `--time-limit` 设为能接受的上限，结束后用 `dsb result` 读取结果。这类宿主不适合派中途需要做决定的任务。

### 4.3 `dsb wait`

阻塞等待作业结束、需要回答、上下文达到提醒阈值或超时。

```text
dsb wait <ID> [OPTIONS]
```

| 参数 | 含义 | 默认值 |
|---|---|---|
| `-t, --timeout <SECONDS>` | 等待上限，1–3600 | `600` |
| `-h, --help` | 打印帮助 | 无 |

`wait` 只读本地文件，等待期间不调用模型。返回一条 JSON，包含 `reason`、当前的 `status` 字段和 `actionableRequests`。`actionableRequests` 是还没回答、也没在排队或送达的请求 ID；`pendingRequests` 列出全部待处理请求。

`reason` 的取值：

| `reason` | 含义 |
|---|---|
| `finished` | 作业进入终态，包括 `cleanup_failed` |
| `request` | 有需要回答的提问或审批 |
| `escalate` | 所有待回答的都是提问，且已达到 3 次提问上限，又没有 `--user-ok` |
| `context` | 上下文达到提醒阈值；每个作业只返回一次 |
| `timeout` | 等待超时，作业仍在运行或排队 |
| `unknown` | 启动器已不在，或心跳过期，且没有其他可返回的原因 |

返回顺序是：已结束优先；否则有请求或 `escalate` 就先返回请求；否则返回 `context`；最后才是 `unknown`；都没有就继续等到超时。作业进入 `finishing` 后不再接受回答，`wait` 不会为了已关闭的请求返回 `request`。作业结束时直接返回 `finished`，不再提醒上下文。`wait` 返回过 `context` 后会在作业目录写 `context.reported`，不会重复提醒。

已经排队或已经送达的回答不会让 `wait` 再返回同一个请求；如果之后出现 `input_rejected`，该请求会重新变成可处理。被取消的请求会从 `pendingRequests` 移除，也不会再让 `wait` 返回。

`wait` 返回只说明发生了什么，不代表作业成功。超时后可以再次调用；有请求时先读 `dsb events` 和 `status.pendingRequests`，再回答。

### 4.4 `dsb status`

```text
dsb status <ID>
```

| 参数 | 含义 | 默认值 |
|---|---|---|
| `-h, --help` | 打印帮助 | 无 |

没有其他命令参数，只有位置参数 `<ID>`。返回一个状态对象：

| 字段 | 含义 |
|---|---|
| `id`、`parentId` | 作业 ID 和返工来源 |
| `processState` | 进程状态；非终态作业在心跳过期时会显示 `unknown` |
| `acceptance` | `unreviewed`、`accepted`、`rework` 或 `blocked` |
| `exitCode` | 子进程退出码，未结束为 `null` |
| `reportedResult` | 作业结束时从报告前 10 行解析出的 `OK`、`FAIL`、`BLOCKED` 或 `UNKNOWN`；未结束为 `null` |
| `cwd`、`startedAt`、`finishedAt` | 工作目录和时间 |
| `reportFile`、`stderrFile`、`eventsFile` | 结果、错误和事件文件路径 |
| `sessionId`、`provider`、`model` | dsh 会话 ID 和模型路由；会话 ID 与作业 ID 相同 |
| `retryKind` | `rework`、`resume` 或 `null` |
| `answeredQuestions`、`questionLimit`、`questionCapLifted` | 已回答的提问数、上限 3、是否已解除上限 |
| `context`、`contextLimit`、`contextReminder` | 最近一次带用量的上下文、阈值、提醒记录 |
| `pendingRequests` | 等待回答的请求，每项有 `requestId`、`method`、`params` |

`status` 不调用模型，只读记录并检查进程和心跳。进程状态和验收结论是两件事：`completed` 只说明进程正常退出，`acceptance` 才是宿主记录的验收结果。

### 4.5 `dsb result`

```text
dsb result <ID>
```

| 参数 | 含义 | 默认值 |
|---|---|---|
| `-h, --help` | 打印帮助 | 无 |

没有其他命令参数，只有位置参数 `<ID>`。返回 `status` 的字段，外加：

| 字段 | 含义 |
|---|---|
| `error` | 作业错误，没有则为 `null` |
| `report` | `report.txt` 的前 6000 字节 |
| `reportTruncated` | 报告是否超过 6000 字节 |
| `usage` | 根会话用量汇总；不可用时 `available:false` 并带 `reason` |
| `verificationRequired` | 还没有 `accepted` 验收时为 `true` |

`report` 被截断时，完整内容在 `reportFile` 指向的 `report.txt`。`usage` 只统计匹配的根会话；缺失的样本不按 0 计算，也不代表包含所有子代理的账单。

### 4.6 `dsb events`

```text
dsb events <ID> [OPTIONS]
```

| 参数 | 含义 | 默认值 |
|---|---|---|
| `--cursor <BYTES>` | 上一次响应返回的字节游标 | `0` |
| `--limit <N>` | 最多返回的事件数，1–200 | `20` |
| `-h, --help` | 打印帮助 | 无 |

返回 `{id, events, cursor, more}`。`cursor` 是日志文件中的字节位置，不是事件序号；下次把它传给 `--cursor`。`more` 为 `true` 表示游标之后还有完整事件。一次响应除了受 `--limit` 限制，还最多读取约 512 KiB。

文件末尾写到一半、没有换行的记录不会被当作事件，也不会让分页卡住；`cursor` 会停在最后一条完整记录之后。开始读时用 `--cursor 0`，之后一直传回返回的游标。

### 4.7 `dsb send`

```text
dsb send <ID> --message <FILE>
```

| 参数 | 含义 | 默认值 |
|---|---|---|
| `-m, --message <FILE>` | UTF-8 消息文件，必填 | 无 |
| `-h, --help` | 打印帮助 | 无 |

消息文件不能为空，最多 48000 字节。返回 `{id, inputId, state:"queued", note}`；`queued` 只表示消息进了 `inbox/`，还要在事件里看到 `input_delivered` 或 `input_rejected` 才算有结果。

追加消息会在下一轮生效，不会打断当前步骤。作业进入 `finishing` 或结束后不再接受输入，应该新建任务或用 `retry`。inbox 最多 256 条，单条序列化后最多 64 KiB。

### 4.8 `dsb answer`

```text
dsb answer <ID> --request <REQUEST_ID> --answer <FILE> [--user-ok]
```

| 参数 | 含义 | 默认值 |
|---|---|---|
| `-r, --request <REQUEST_ID>` | 待回答请求的 ID，必填 | 无 |
| `-a, --answer <FILE>` | UTF-8 JSON 回答文件，必填 | 无 |
| `-u, --user-ok` | 用户同意后，回答超过 3 次提问上限 | 关闭 |
| `-h, --help` | 打印帮助 | 无 |

`requestId` 必须来自当前作业的 `pendingRequests` 或 `request` 事件；请求已经不待处理时会拒绝。回答文件必须是合法 JSON，最多 48000 字节。返回的 `queued` 同样只表示进队；排队时只检查请求当前仍在待处理、启动器存活和提问上限，JSON 回答的结构在送达时校验，失败会记录 `input_rejected`，请求保持待处理。

普通提问和审批的回答格式见第 5 节。回答成功后记录 `input_delivered`，请求从 `pendingRequests` 移除。

### 4.9 `dsb retry`

```text
dsb retry <ID> --feedback <FILE> [OPTIONS]
```

| 参数 | 含义 | 默认值 |
|---|---|---|
| `-f, --feedback <FILE>` | UTF-8 返工反馈文件，必填 | 无 |
| `--resume` | 只继续被超时或未回答提问中断的工作；不算返工 | 关闭 |
| `-u, --user-ok` | 用户同意后，超过 1 次返工上限 | 关闭 |
| `-h, --help` | 打印帮助 | 无 |

`retry` 会新开一个会话，沿用原作业的 `cwd`、原始 brief、补丁、图片、provider、model、范围、只读声明、资源、并发上限、上下文阈值和 dsh 入口，并把反馈作为返工说明附加到提示中。作业记录里用 `retryKind` 标记 `rework` 或 `resume`。

允许重试前会检查：原作业处于已记录的终态；不是 `cleanup_failed`；还没有被 `accepted`；补丁文件、图片、原始 brief 副本都没有被改动。任何一项不满足都会要求新建任务或先处理原作业。`--resume` 只改变计数和记录，不检查上次中断原因；宿主应只在超时或未回答提问导致中断时使用。

`retry` 的输出和退出码规则与 `run` 相同。

### 4.10 `dsb review`

```text
dsb review <ID> --verdict <VERDICT> --note <EVIDENCE> [OPTIONS]
```

| 参数 | 含义 | 默认值 |
|---|---|---|
| `--verdict <VERDICT>` | `accepted`、`rework` 或 `blocked`，必填 | 无 |
| `--note <EVIDENCE>` | 实际检查过的验收证据，必填 | 无 |
| `--accounting <FILE>` | 可选的成本 JSON，例如 `{"currency":"CNY","source":"...","deepseekCost":0.12}` | 无 |
| `-h, --help` | 打印帮助 | 无 |

`review` 只能用于已记录的终态；活动作业、`unknown` 或 `cleanup_failed` 会被拒绝。标记 `accepted` 还要求退出码为 0、`reportedResult` 为 `OK`；失败或报告不是 OK 的作业只能记录 `rework` 或 `blocked`。

`--accounting` 必须是合法 JSON，包含非空的 `currency` 和 `source`。形如 `deepseekCost` 的 `*Cost` 键会被记录和汇总；值必须是非负有限数字，`null` 表示未知，未知的成本应省略而不是写 0。

### 4.11 `dsb cancel`

```text
dsb cancel <ID>
```

| 参数 | 含义 | 默认值 |
|---|---|---|
| `-h, --help` | 打印帮助 | 无 |

没有其他命令参数，只有位置参数 `<ID>`。如果作业已经是终态，返回 `cancelRequested:false`；如果是 `cleanup_failed`，直接报错；如果启动器已经不在或心跳过期，也会报错。否则写入 `cancel.request`，返回 `cancelRequested:true` 和提示。

返回只表示取消请求已排队，不代表进程已经退出。子进程会由启动器结束：Windows 使用 `taskkill /PID <pid> /T /F`，其他平台先发 `SIGTERM`，必要时再发 `SIGKILL`。要等 `dsb wait` 返回 `finished` 或 `status.processState` 变成 `cancelled` 后再创建新任务。

### 4.12 `dsb unlock`

```text
dsb unlock <ID> --confirm-stopped
```

| 参数 | 含义 | 默认值 |
|---|---|---|
| `--confirm-stopped` | 确认原任务及其子进程都已停止，必填 | 无 |
| `-h, --help` | 打印帮助 | 无 |

它用于释放崩溃或清理失败后一直保留的调度预约。运行前要确认原任务和所有相关进程都已停止，并检查过已完成的部分改动。如果启动器按 PID 加心跳仍被判定为存活，`unlock` 会拒绝；如果启动器已经不存活，即使记录中的子进程 PID 仍然存在，它也会继续释放，并在 `warning` 字段里列出仍然存在的 supervisor 或 child PID。看到 `warning` 时要先核实这些进程，再复用工作区。

`unlock` 不会把 `cleanup_failed` 改成可重试或可验收；它只释放预约。之后应检查部分改动，再用新的 `dsb run` 开始任务。

### 4.13 `dsb stats`

```text
dsb stats
```

| 参数 | 含义 | 默认值 |
|---|---|---|
| `-h, --help` | 打印帮助 | 无 |

没有其他命令参数。返回一个汇总对象，主要字段：

| 字段 | 含义 |
|---|---|
| `jobs`、`legacyJobs`、`unreadableJobs` | v2 作业数、v1 旧作业数、无法读取的记录数 |
| `tasks`、`retries` | 按 `rootId` 去重的任务数、带 `parentId` 的返工数 |
| `acceptedTasks`、`acceptedFirstAttempts` | 已验收的任务数、首次派单就验收的作业数 |
| `usageRecords`、`missingUsageRecords` | 有用量记录和缺失用量记录的作业数 |
| `observedSessionTokens`、`tokenRecords`、`missingTokenRecords` | 按 token 类型汇总的观测值、记录数和缺失数 |
| `costsByCurrency` | 按币种汇总的 `*Cost` 记录 |
| `note` | 关于用量和成本口径的说明 |

`stats` 只读本地作业记录。缺失用量不会被当作 0；成本来自 `review --accounting` 记录，不是从 token 推算的。

## 5. 提问、权限与上限

### 5.1 普通提问的回答格式

请求的 `params.questions` 是一个数组，每项至少有 `id`，通常还有 `question`、`options` 等字段。回答文件是一个 JSON 对象：

```json
{"answers":[{"id":"original-question-id","selected":["选项 A"],"custom":"宿主补充的信息"}]}
```

- `id` 必须是原问题的 ID；每个问题恰好回答一次，不能重复、遗漏或多出。
- `selected` 必须是字符串数组；问题提供选项时填选中的标签，自由回答时用 `[]`。
- `custom` 可选，必须是字符串；没有就省略。

桥只把回答原样转发给 dsh，不做语义判断。回答不合法时，请求保持待处理，事件里出现 `input_rejected`，修正后可以重新回答。

### 5.2 权限审批

审批请求的方法是 `approval/request`，回答是以下三种之一：

```json
{"outcome":"allowed-once"}
```

```json
{"outcome":"rejected"}
```

```json
{"outcome":"cancelled"}
```

审批请求在 SDK 线上通常没有请求 ID，桥会生成一个本地 UUID 并放进 `params.requestId`；`dsb status` 和 `request` 事件里看到的就是它，`dsb answer --request` 用同一个 ID。

批不批准由宿主按自己实际拥有的权限决定，桥不会自动授予任何权限。需要用户拍板时，宿主要先问用户，再按用户的决定回答；沙箱和 dsh 的权限检查仍然生效。

### 5.3 3 次提问上限与 `--user-ok`

每个作业最多回答 3 个普通提问，审批请求不计入也不受限。计数发生在回答真正送达 dsh 时；`status.answeredQuestions` 是已回答数，`questionLimit` 是 3。

第 4 个提问的回答会被 `dsb answer` 拒绝，除非命令带 `--user-ok`。此时 `dsb wait` 返回 `escalate`，而不是 `request`；审批请求仍返回 `request`。宿主应先告诉用户当前情况；用户决定继续后，用 `--user-ok` 重发这次回答。该回答送达后 `questionCapLifted` 为真，这个作业之后的提问不再受 3 次限制。

`--user-ok` 只解除当前作业的提问上限，不会改变审批权限，也不会影响其他作业。

### 5.4 1 次返工上限与 `--resume`

同一个任务（共享 `rootId` 的作业）只允许 1 次返工。带 `parentId` 但没有 `retryKind` 的旧作业也算一次返工。第二次 `dsb retry` 会被拒绝，除非带 `--user-ok`；使用前要告诉用户当前状态、已经试过什么和失败证据。

`--resume` 表示只继续被超时或未回答提问中断的工作，不算返工，也不受 1 次限制；记录里的 `retryKind` 是 `resume`。桥不检查上次中断的具体原因，所以只在确实属于这两种情况时使用。

已经 `accepted` 的作业不能重试；`cleanup_failed` 的作业也不能重试或验收，需要先按第 7 节处理。补丁、图片或原始 brief 副本发生变化时，也不能沿用旧作业，必须新建任务。

### 5.5 上下文提醒

上下文提醒阈值默认是 200000 token，可以用 `dsb run --context-limit <TOKENS>` 或环境变量 `DPSK_CONTEXT_LIMIT` 调整；`retry` 沿用原作业记录的值。

每次收到带用量的助手消息，桥都会更新 `status.context`，token 数是 `inputTokens + cacheReadTokens + cacheWriteTokens`。第一次达到阈值时记录 `status.contextReminder` 和 `context_reminder` 事件，作业继续运行。`dsb status` 同时显示 `context` 和 `contextLimit`。

`dsb wait` 在没有请求、没有结束的情况下会返回一次 `context`，并在作业目录写 `context.reported` 标记；同一个作业不会再提醒。收到提醒后可以检查进度，决定让它继续、用一条短消息收窄范围，或者取消并把剩余工作拆成更小的作业。

### 5.6 相关事件

| 事件 | 关键字段 | 含义 |
|---|---|---|
| `request` | `requestId`、`method`、`params` | dsh 发来提问或审批；`method` 是 `user-question/ask` 或 `approval/request` |
| `input_delivered` | `inputId`、`requestId`（回答）、`receipt`（消息） | 输入已经写入 SDK 连接；之后 dsh 内部的校验或执行错误不会再产生单独的桥事件 |
| `input_rejected` | `inputId`、`error`、`requestId`（回答） | 输入没有送达；常见原因是请求已取消、已不待处理、回答格式不合法或作业已结束 |
| `request_cancelled` | `requestId` | dsh 撤回了请求；请求从 `pendingRequests` 移除，仍在队列里的回答会收到 `input_rejected` |
| `context_reminder` | `tokens`、`threshold` | 第一次达到上下文阈值 |
| `turn_finished` | `reason` | dsh 的一轮结束，`reason` 是 `completed` 等值 |
| `notification` | `method`、`params` | SDK 通知的原始记录，例如 `session.event` |
| `bookkeeping_failed` | `error` | 作业记录或事件写入失败；作业结果不会被这类记录失败改写 |

`dsb run` 的 stdout 还会输出 `queued`、`started` 和最终的 `finished`，这些是给调用方的流式事件，不一定出现在 `events.jsonl` 里。

## 6. 并发、范围与资源

### 6.1 并发上限

默认最多同时运行 8 个作业。共享同一个 `DSH_HOME` 的启动器一起参与排队；`DPSK_CONCURRENCY` 或 `--concurrency` 可以设成 1–256。

有效上限取所有参与启动器的最小值：一个启动器设 32、另一个设 8，实际就是 8。`dsb retry` 沿用原作业记录的 `maxConcurrent`，不读当前的 `DPSK_CONCURRENCY`。想统一提高并发，就给所有启动器设同一个环境变量。256 只是上限，实际速度还受服务配额、机器资源和范围冲突限制。

### 6.2 范围和写任务

写任务默认锁住整个 Git 工作区；不是 Git 目录时锁 `--cwd` 本身。`--scope` 可以重复，路径相对于 Git 工作区根目录。互不重叠的范围可以并行；有父子关系或重叠的范围会排队等待。

```text
dsb run --cwd "项目" --brief "前端.md" --scope src/frontend --concurrency 32
dsb run --cwd "项目" --brief "后端.md" --scope src/backend --concurrency 32
```

范围只是协作约定，不是文件系统沙箱。宿主原有的权限、dsh 的沙箱和 MCP 权限照常生效；`--scope` 不会阻止进程读写范围外的文件，只是让遵守约定的启动器排队。

### 6.3 只读任务

`--read-only` 声明这个任务只读，表示任务承诺不修改文件和外部状态。它是协作约定，不是强制沙箱；遵守约定的只读任务之间可以并行，它们和范围重叠的写任务互斥。没有给 `--scope` 时，只读任务的范围也是整个工作区，因此会与同一工作区的写任务冲突；给出互不重叠的 `--scope` 后，才可能与写任务并行。

```text
dsb run --cwd "项目" --brief "调查.md" --read-only
```

### 6.4 共享资源

`--resource` 声明任务要独占的外部资源，例如同一台编辑器、同一个本地服务或同一个 MCP 实例。名字相同的任务跨工作区互斥；名字会去掉首尾空白并去重，每个最多 500 个字符。

```text
dsb run --cwd "另一个项目" --brief "场景编辑.md" --resource unity-editor-main
```

### 6.5 排队与预约

调度状态保存在 `$DSH_HOME/bridge/scheduler/state.json`，是本地文件系统上的协作队列，不是跨机器的锁。冲突规则：

| 组合 | 结果 |
|---|---|
| 两个写任务，范围重叠或互为父子 | 串行 |
| 两个写任务，范围不相交 | 可以并行，仍受并发上限限制 |
| 两个只读任务 | 可以并行 |
| 只读任务与写任务，范围重叠 | 串行 |
| 相同的 `--resource`，任意工作区 | 串行 |
| 独占更新与任何作业 | 更新等待所有作业结束 |

取消和总超时都把排队时间算在内。作业崩溃或清理无法确认时，已经激活的预约会一直保留；还在排队、但启动器已经消失的预约会被清掉。处理办法见第 7 节的 `cancel` 和 `unlock`。所有参与调度的启动器要使用同一版本的 `dsb`；升级前先结束旧作业，避免旧启动器和新调度协议同时操作同一个 `DSH_HOME`。

## 7. 作业状态与故障处理

### 7.1 `processState` 各值

| 值 | 含义 |
|---|---|
| `queued` | 已创建记录，正在等调度名额 |
| `starting` | 已拿到名额，正在准备和启动 dsh |
| `running` | dsh 子进程正在运行 |
| `finishing` | dsh 这一轮已结束，停止接收输入，正在收尾和关闭 |
| `completed` | 子进程退出码为 0，且没有取消或超时原因 |
| `failed` | SDK 通信或运行错误，或子进程非零退出；具体原因看 `error` |
| `timed_out` | 达到 `--time-limit`；排队时间也算在内 |
| `cancelled` | 收到取消请求，或启动器收到 SIGINT/SIGTERM |
| `launch_failed` | 子进程无法启动 |
| `cleanup_failed` | 进程树清理或预约释放失败；不能重试或验收，需要先处理残留进程 |
| `unknown` | 记录仍是非终态，但启动器 PID 不在或心跳过期；这是 `status`/`wait` 推导出的值，不写进记录 |

`completed` 只表示进程正常退出，不表示报告通过。`reportedResult` 是模型自报的结果，`acceptance` 是宿主记录的验收结论，三者互相独立。

`retry` 和 `review` 只接受记录中的终态（`completed`、`failed`、`timed_out`、`cancelled`、`launch_failed`）；`cleanup_failed` 有单独的处理规则，`unknown` 不是终态。

### 7.2 心跳与存活判定

启动器每 5 秒刷新一次作业目录里的 `heartbeat` 文件。判断启动器是否还活着时，桥要求记录的 PID 仍然存在，并且心跳文件的修改时间在 60 秒以内。没有心跳文件的旧记录仍只检查 PID，因为对旧记录无法区分 PID 复用。

这样，Windows 复用了 PID 也不会让旧作业一直显示为运行中。`status`、`wait` 和 `dsv` 都会把心跳过期的作业当作不存活：`status`/`wait` 显示 `unknown`，`dsv` 对由 `dsb` 派出的、日志里这一轮还没结束的会话显示 `Interrupted`。日志一段时间没有更新不能证明进程已经停止，必须结合心跳、PID 和宿主自己的进程句柄判断。

### 7.3 `dsb cancel` 与清理

`dsb cancel` 只是写一个取消标记，启动器每 100 毫秒检查一次。排队中的作业会在申请名额时被中断；运行中的作业会被结束进程树。Windows 使用 `taskkill /PID <pid> /T /F`，其他平台先发 `SIGTERM`，1.5 秒后仍在就发 `SIGKILL`。清理失败会把状态记为 `cleanup_failed` 并保留预约。

取消请求被接受后要等作业真正进入终态（通常是 `cancelled`，也可能先被总超时记为 `timed_out`）；不要立刻派新任务去改同一个工作区。

### 7.4 `dsb unlock --confirm-stopped`

`unlock` 用于释放 `cleanup_failed` 或崩溃后保留的预约。前提是启动器已经不在或心跳过期；如果启动器仍被判定为存活，`unlock` 会拒绝。释放前要确认原任务和所有相关进程都已停止，并检查部分改动。

如果记录中的 child PID 仍然存在，`unlock` 仍会释放预约，并在 `warning` 里列出 PID。这不是“进程已经安全退出”的证明，看到警告要先核实。`unlock` 不会改变作业的 `cleanup_failed` 状态，因此该作业仍然不能重试或验收；检查完部分结果后，用新的 `dsb run` 开始。

### 7.5 常见问题

| 现象 | 处理 |
|---|---|
| 作业一直 `queued` | 检查并发上限、同工作区的范围冲突、同名 `--resource` 的持有者；取消和超时都包含排队时间 |
| `wait` 返回 `timeout` | 正常现象，作业还在运行或排队；再次调用 `wait` |
| `wait` 返回 `unknown` | 启动器可能已经退出或心跳过期；检查 `status`、宿主进程句柄和作业目录，确认进程停止后再决定是否 `unlock` |
| `cleanup_failed` | 先按 `stderr.log`、`job.json` 和系统进程检查残留；确认停止后用 `unlock --confirm-stopped`，再新建任务 |
| `send`/`answer` 返回 `queued` 后没有变化 | 继续读 `events`，找对应的 `input_delivered` 或 `input_rejected`；请求可能已经 `request_cancelled` |
| 第 4 个提问被拒绝 | 先告诉用户；用户决定继续后用 `dsb answer --user-ok`，该作业之后的提问不再受限 |
| `retry` 被拒绝 | 检查原作业是否终态、是否已 `accepted`、是否 `cleanup_failed`、补丁/图片/brief 副本是否改变；第二次返工需要用户同意后加 `--user-ok` |
| 找不到 dsh 或版本过低 | 安装或升级 `@deepseek-ai/dsh` 到 ≥0.2.2-alpha.3，或用 `--dsh-entry` 指向 `lib/bin.js` |
| brief 太长或为空 | 控制在 48000 字节以内，写目标和引用路径，不要粘贴大段源码或历史 |
| 图片被拒绝 | 只支持 JPEG/PNG/GIF/WebP，最多 20 张，首条消息编码后不超过 8 MiB |
| 报告没有 `RESULT` | 结果记为 `UNKNOWN`；`RESULT` 行必须在回复前 10 行内、以 `RESULT:` 开头，不能放在代码块里 |
| 旧作业读不出来 | v1 作业记录不再读取；用 `dsv` 查看会话日志，或新建任务 |

报告解析规则：从最后一条助手回复的前 10 行里找 `RESULT: OK`、`RESULT: FAIL` 或 `RESULT: BLOCKED`。这一行去掉首尾空白后要以它开头，可以加粗，不能放在以三个反引号开头的围栏代码块里；`OK`、`FAIL`、`BLOCKED` 之后必须是行尾或空白。找不到就是 `UNKNOWN`。`dsb result` 的 `report` 只返回前 6000 字节，完整内容看 `report.txt`。

## 8. dsv 会话查看器

### 8.1 命令

| 命令 | 作用 |
|---|---|
| `dsv` | 全屏 TUI；不是终端时打印 `ls` 表 |
| `dsv ls [N]` | 最近的 N 个会话，默认 15 |
| `dsv show [ID\|latest]` | 结果优先的阅读视图；`s` 是别名 |
| `dsv show <ID> --details` | 按时间显示完整过程 |
| `dsv show <ID> --full` | 不截断工具输出，并使用过程视图 |
| `dsv watch [ID]` | 实时跟踪；`w` 是别名；不给 ID 时跟随最新会话 |
| `dsv update` | 检查并安装更新，详见第 3.6 节 |
| `dsv --snapshot <COLS>x<ROWS>` | 按界面布局输出一帧纯文本，用于排查界面问题 |

会话选择器可以是完整 ID、唯一前缀，或 `latest`。`--snapshot` 还可以加 `--focus list|detail` 和 `--select <ID_PREFIX>`；加 `--details` 或 `--all` 时使用过程视图。

### 8.2 常用选项

| 选项 | 含义 | 默认值 |
|---|---|---|
| `--details` | `show`：按时间显示完整过程 | 关闭 |
| `--full` | `show`：不截断工具输出 | 关闭 |
| `--reasoning` | `show`：包含模型思考 | 关闭 |
| `--no-reasoning` | `show`：隐藏模型思考 | 关闭（默认就不显示） |
| `--all` | `show`：包含系统和开发者消息，隐含 `--details`，并像 `--full` 一样不截断工具输出 | 关闭 |
| `--snapshot <COLS>x<ROWS>` | 输出一帧纯文本 | 无 |
| `--focus list\|detail` | 配合 `--snapshot` 指定焦点面板 | `list` |
| `--select <ID_PREFIX>` | 配合 `--snapshot` 指定会话 | 无 |
| `--check` | `update`：只检查，不安装 | 关闭 |
| `--auto on\|off` | `update`：开启或关闭自动更新 | `off` |
| `--recover --confirm-stopped` | `update`：释放清理失败后保留的更新预约 | 关闭 |
| `--no-update-check` | 全屏界面不检查更新 | 关闭 |
| `-V, --version` | 打印版本 | 无 |
| `-h, --help` | 打印帮助 | 无 |

### 8.3 分组规则

列表固定分成两大组：

- **Running**：按状态再分三组：
  - **Active**：这一轮还开着，最后一次更新在 5 分钟以内。
  - **No updates**：这一轮还开着，但超过 5 分钟没有更新；超过 30 分钟的会话会移到 Finished，但仍然标着 No updates。
  - **Just ended**：会话不再处于打开状态（成功、失败、中断或读取失败），最后一次更新在 2 分钟以内。
- **Finished**：按日期分组，例如 `2026-11-2`。最近一天默认展开，更早的默认折叠。

会话结束后，不管成功与否，都会在 Just ended 里停留 2 分钟，然后移到 Finished。正在查看且仍在 Running 的会话会一直留在 Running；切到别的会话后重新计时 2 分钟。没有内容的子组会省略，但两个顶层组始终显示。

**Interrupted** 是状态标签，不是单独的组：由 `dsb` 派出的会话，如果日志里这一轮还没结束，但桥的作业已经不在运行（启动器被意外结束、心跳超过 60 秒没有更新，或作业已取消、失败、超时），就显示为 Interrupted。它不会再继续，按“刚结束”的规则在 Running 停留 2 分钟，然后移到 Finished。不是 `dsb` 派出的会话仍按日志判断状态。

### 8.4 阅读视图与过程视图

阅读视图先显示待回复的问题，再显示最新的最终结果、最后一次进展、任务原文、最近两个错误和附件；任务和问题可以展开。成功的工具输出、思考、时间戳和用量不占正文，工具调用会汇总成一行，提示按 `d` 打开完整过程。

过程视图严格按时间排列；一次工具调用和它的返回合并成一条可展开的记录，同一轮的计划更新合并成一条。当前轮次之前的最终结果会标成 Previous result。

`d` 在两种视图之间切换；正文框右下角显示 `d  Reading │ Process`，也可以点击。`r` 切换是否显示思考，`s` 切换是否显示系统和开发者消息（打开时自动切到过程视图），`f` 切换全部展开，`e`/`E` 逐块全部展开或收起。

### 8.5 按键

**全局**

| 键 | 作用 |
|---|---|
| `q`、`Ctrl+C` | 退出；更新正在进行时会提示等待 |
| `?` | 打开或关闭帮助 |
| `Tab`、`Shift+Tab` | 切换列表面板和正文面板 |
| `d` | 阅读/过程视图切换 |
| `r` | 显示/隐藏思考 |
| `f` | 全部展开开关 |
| `s` | 显示/隐藏系统和开发者消息；打开时切到过程视图 |
| `i` | 显示/隐藏路径、会话 ID 和用量 |
| `z`、`Z` | 折叠/展开全部分组 |
| `n` | 跳到 Running 组里的下一个会话 |
| `a` | 自动跟随有更新的会话（默认关闭） |
| `b` | 会话结束提示音（默认关闭） |
| `u` | 检查并安装更新 |
| `Ctrl+L` | 重绘屏幕 |

**列表**

| 键 | 作用 |
|---|---|
| `↑`、`↓`、`j`、`k` | 选择会话；右边立即显示选中的会话 |
| `PgUp`、`PgDn` | 跳 5 项 |
| `g`、`Home` | 第一项 |
| `G`、`End` | 最后一项 |
| `Enter`、`Space` | 组标题：展开/折叠；会话：进入正文 |
| `→` | 组标题：展开；会话：进入正文 |
| `←` | 折叠所在的组 |

**正文**

| 键 | 作用 |
|---|---|
| `↑`、`↓`、`j`、`k` | 按内容块移动 |
| `Enter`、`Space` | 展开/收起当前块 |
| `PgUp`、`PgDn` | 翻页，高亮跟到新的一页 |
| `Ctrl+U`、`Ctrl+D` | 滚动半页，高亮留在原来的块上 |
| `g`、`Home` | 到顶部 |
| `G`、`End` | 到底部并跟随最新内容 |
| `e`、`E` | 逐块全部展开/收起 |
| `Esc`、`←` | 回到列表 |

滚动之后按 `j`、`k` 或 `Enter`，会从屏幕上看得到的块继续。

**帮助**

| 键 | 作用 |
|---|---|
| `?`、`Esc` | 关闭帮助 |
| `↑`、`↓`、`j`、`k` | 滚动一行 |
| `PgUp`、`PgDn`、`Ctrl+U`、`Ctrl+D` | 翻页 |

帮助是模态的：打开时列表和正文不会被改动，只处理帮助滚动、关闭，以及 `q`、`Ctrl+C`、`Ctrl+L`、`u`、`?` 这些全局键。窗口装不下时自动换行，帮助内容可以滚动。

**鼠标**

| 操作 | 作用 |
|---|---|
| 点击会话 | 选中；窄窗口里直接进入正文 |
| 点击组标题 | 展开/折叠 |
| 点击正文块 | 选中并展开/收起该块 |
| 点击正文框右下角的 `d`、`Reading`、`Process` | 切换或选择视图 |
| 点击底栏按键 | 触发对应按键；`? Help` 和 `q Quit` 始终在右边 |
| 滚轮 | 只滚动鼠标所在的面板；帮助打开时只滚动帮助 |

用 `j`/`k`、`Enter`、`→`、鼠标或 `n` 自己选择会话时，自动跟随会关闭；按 `a` 才会重新跟随。底部按键放不下时，优先保留 `Tab` 和 `Enter`，`?` 与 `q` 始终保留。

### 8.6 布局、缓存与日志

- 界面文字是英文，左边是 Sessions，右边是 Transcript；有焦点的面板边框高亮，启动时焦点在列表上。
- 窗口宽度不足 100 列时一次只显示一个面板；窄窗口里点击会话直接进入正文。
- 改变窗口大小会自动整屏重画；画面仍然错乱时按 `Ctrl+L`。
- 每个会话各自记住滚动位置和展开状态。
- 列表最多保留最近 60 个会话；标题在后台陆续读取，不阻塞界面。
- 全屏界面为单个会话保留 16 MiB 或 3 万条事件的上限，超过时显示读取失败。解码缓存总共 64 MiB，超出时释放没在看的会话正文，但保留列表信息；再打开时重新读取。
- 读取 v4 格式的明文或 zstd 压缩日志，会处理写到一半的尾部、工具结果、系统消息、结构化错误和用量。同一会话有多代日志时取版本号最高的一代，同版本取较新的文件；遇到更高的未知格式会提示尚未验证。
- `DSH_SESSIONS_ROOT` 可以指定会话日志根目录；没有设置时是 `$DSH_HOME/sessions`，`DSH_HOME` 默认是 `~/.dsh`。
- 日志状态不能证明进程还活着，也不代表验收通过；桥接作业的进程状态以 `dsb status` 为准。

`dsv watch` 用过程视图实时输出：每秒读一次正文，每 5 秒重新扫描会话树；没有指定 ID 时会自动切到新出现的会话，指定 ID 时只跟这个会话。`Ctrl+C` 停止。

## 9. 环境变量一览

| 变量 | 作用 | 默认值或备注 |
|---|---|---|
| `DPSK_PROVIDER` | `run` 的默认模型路由 | `deepseek-official`；`--provider` 优先；`retry` 沿用原作业 |
| `DPSK_MODEL` | `run` 的默认模型名 | `deepseek-flash`；`--model` 优先；`retry` 沿用原作业 |
| `DPSK_CONCURRENCY` | 并发作业上限 | `8`；范围 1–256；`--concurrency` 优先；所有启动器取最小；`retry` 沿用原作业 |
| `DPSK_CONTEXT_LIMIT` | 上下文提醒阈值，单位 token | `200000`；正整数；`--context-limit` 优先；`retry` 沿用原作业 |
| `DSH_HOME` | dsh 主目录 | `~/.dsh`；桥作业在 `$DSH_HOME/bridge` |
| `DSH_SESSIONS_ROOT` | dsv 的会话日志根目录 | `$DSH_HOME/sessions` |
| `NO_UPDATE_NOTIFIER` | 关闭 dsv 全屏界面的后台更新检查 | 未设置；设为非空值即关闭，手动 `dsv update` 仍可用 |
| `CI` | 标记 CI 环境，关闭 dsv 后台更新检查 | 未设置；设为非空值即关闭 |
| `DPSK_REAL_DSH_ENTRY` | 真实 dsh 集成测试的入口 `lib/bin.js` | 未设置；只用于 `test/real-dsh.test.mjs`，未设置时测试跳过 |

参数优先于环境变量；`retry` 沿用原作业记录的值，不重新读 `DPSK_CONCURRENCY`、`DPSK_CONTEXT_LIMIT` 等变量。

## 10. 开发与发布

### 10.1 本地检查

```text
npm ci --ignore-scripts
npm run check
npm test
```

`npm run check` 对 `bin/`、`lib/` 和 `scripts/sync-skills.mjs` 逐个运行 `node --check`，只检查语法，不做类型检查或 lint。`npm test` 用 `node --test "test/**/*.test.mjs"` 运行全部测试。

测试覆盖命令行解析和帮助文本、作业生命周期、等待与心跳、调度队列和范围冲突、原生提问和审批、事件游标、会话日志读取、报告状态、dsv 的界面/布局/存储、更新器、安装脚本和 skill 同步。

### 10.2 真实 dsh 集成测试

`test/real-dsh.test.mjs` 默认跳过；设置 `DPSK_REAL_DSH_ENTRY` 指向当前 dsh 的 `lib/bin.js` 后运行：

```powershell
$env:DPSK_REAL_DSH_ENTRY = "C:\path\to\node_modules\@deepseek-ai\dsh\lib\bin.js"
node --test test/real-dsh.test.mjs
```

```bash
DPSK_REAL_DSH_ENTRY=/path/to/node_modules/@deepseek-ai/dsh/lib/bin.js node --test test/real-dsh.test.mjs
```

这个测试使用隔离的临时 `DSH_HOME`，删除 `DEEPSEEK_API_KEY`，设置 `DSH_TELEMETRY_DISABLED=1` 和 `DSH_PERMISSION_MODE=workspace-write`，再注入一个本地模拟模型插件；它不请求付费模型，验证原生提问、权限审批、追加消息和 v4 日志，超时时间是 120 秒。

### 10.3 CI

`.github/workflows/ci.yml` 在推送到 `main` 和所有 pull request 上运行，矩阵是 `ubuntu-latest` 和 `windows-latest`，Node.js 24。步骤是：

```text
npm ci --ignore-scripts
npm run check
npm test
```

### 10.4 发布

发布使用 Git tag。维护者先提交版本号和 lockfile，通过 CI，再推送与 `package.json` 中 `version` 一致的正式 tag：

```text
npm version patch
git push origin main --follow-tags
```

`.github/workflows/release.yml` 在推送 `v*` tag 时运行。它先检查 tag 必须是 `v` 加 `package.json` 的版本，且版本是稳定的 semver（不能是预发布版）；然后运行 `npm ci --ignore-scripts`、`npm run check`、`npm test`，用 `npm pack --ignore-scripts` 打包，生成 `SHA256SUMS`，最后用 `gh release create --verify-tag --generate-notes` 创建 GitHub Release，并附上 `.tgz` 和校验和。

更新器只接受已发布、非草稿、非预发布的正式 Release；只有提交或 tag、没有对应 Release 时，不会提示用户更新。项目当前是私有包，不通过 npm registry 分发，安装和更新都基于 Git 检出。完整的版本变化见 [CHANGELOG.md](../CHANGELOG.md)。
