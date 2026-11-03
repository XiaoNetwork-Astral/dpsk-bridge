# 使用参考

README 只放最常用的内容，这里是完整说明。每个命令的参数以 `dsb <命令> --help` 为准。

## 安装细节

安装脚本会安装锁定版本的依赖，dsh 不满足版本要求时安装或升级它，同步所选宿主的 skills，并通过 `npm link` 提供 `dsb`/`dsv`。装好后不要移动安装目录，并重新打开宿主会话。脚本不会动 dsh 的登录信息和 `~/.dsh/patches/`；覆盖托管的 skill 之前，会先备份到 `~/.dpsk-bridge/backups/`。

需要多个宿主时分别运行一次，例如 `-Target Codex`、`-Target Claude`、`-Target Generic -SkillsDir <目录>`。要卸载某个宿主，在同样的命令后加 `-Uninstall`（Generic 还要带上原来的 `-SkillsDir`）。只要还有其他宿主在用，共享的命令入口就会保留。

从旧项目名升级：先结束旧作业，把 origin 改成新地址，拉取代码，再重新运行所选宿主的安装命令。脚本会迁移旧的 skill 归属清单和命令入口；旧格式的作业不再读取，历史日志不会删除。

## 双向任务

```text
dsb run --cwd "项目路径" --brief "brief.md" --time-limit 2700
dsb run --cwd "项目路径" --brief "brief.md" --patch "MCP配置.yml"
dsb run --cwd "项目路径" --brief "brief.md" --provider deepseek-official --model deepseek-flash
dsb status <作业ID>
dsb wait <作业ID> --timeout 600
dsb events <作业ID> --cursor 0 --limit 20
dsb send <作业ID> --message "追加要求.md"
dsb answer <作业ID> --request <requestId> --answer "回复.json"
dsb result <作业ID>
dsb cancel <作业ID>
```

`run` 会一直挂着，直到作业结束。宿主要保留这个进程的句柄，然后用 `dsb wait` 等待，每次返回后读取新的问题和进展。如果宿主的命令工具在命令运行期间拿不到输出，就把 `--time-limit` 设成能接受的上限，等结束后用 `dsb result` 读结果。这类宿主只适合派中途不需要做决定的任务。

`events` 返回完整事件和一个字节游标（cursor，表示读到了日志的第几个字节）。下次把这个游标传给 `--cursor` 继续读；`more` 为真表示还有没读完的事件。`status.pendingRequests` 列出等待回复的问题和审批。回复普通问题时，按原问题的 ID 逐条填写：

```json
{"answers":[{"id":"original-question-id","selected":[],"custom":"宿主补充的信息"}]}
```

审批的回复是 `{"outcome":"allowed-once"}`、`{"outcome":"rejected"}` 或 `{"outcome":"cancelled"}`。批不批准由宿主按自己实际拥有的权限决定，桥不会自动授予任何权限；需要用户拍板时先问用户。提问和审批由随作业加载的 Harness 插件转发；追加消息和实时日志由 SDK 负责。每个作业有独立的 SDK 进程。

每个作业最多回答 3 个提问请求；审批请求不计入也不受限。第 4 个提问的回答会被拒绝，除非命令带 `--user-ok`。宿主应先告诉用户当前情况；用户决定继续后，用 `--user-ok` 重发这次回答，该作业之后的提问就不再受限。被限制时 `dsb wait` 返回 `escalate`，而不是 `request`；审批仍返回 `request`。`dsb status` 显示 `answeredQuestions` 和 `questionLimit`。

`send`/`answer` 返回 `queued` 只表示消息进了邮箱，还要在事件里看到 `input_delivered` 或 `input_rejected` 才算有结果。通过文件通道转交给宿主插件的回答，会先出现 `input_forwarded`（已转交、等待处理），这不等于已送达，仍要继续等。追加的要求在下一轮生效，不会打断当前步骤。作业结束后不能再追加，应该新建任务或用 `retry`。

### 等待：dsb wait

宿主没有"后台命令结束时自动唤醒模型"的能力时，不要反复查询 `status` 或 `events`，因为每查一次都是一次付费的模型调用。正确做法是把 `run` 放到后台，然后运行 `dsb wait <作业ID> --timeout <秒>`。

`wait` 只读本地文件，等待期间不调用模型。遇到以下任一情况时返回一次：

- 作业结束：`finished`，包括 `cleanup_failed`；
- 启动器意外退出：`unknown`；
- 出现需要回复的问题或审批：`request`；
- 提问数已达上限且没有 `--user-ok` 解除：`escalate`；
- 上下文达到提醒阈值：`context`，每个作业只返回一次；
- 超时：`timeout`。

`--timeout` 默认 600 秒，范围 1–3600，而且不能超过宿主单次命令允许的时长。返回结果里的 `actionableRequests` 是还没回复的请求；`pendingRequests` 列出全部待处理请求。已经回复过的请求（回答在排队或已送达）不会再让 `wait` 返回 `request`，除非之后出现 `input_rejected`。有请求或 `escalate` 时先返回它们，`context` 在之后一次 `wait` 返回；作业已经结束时直接返回 `finished`，不再提醒上下文；返回过 `context` 后会在作业目录写一个标记文件，不再重复。`wait` 返回只说明发生了什么，不代表成功，仍然要读结果并验收。

上下文提醒的阈值默认 200000 token，可以用 `dsb run --context-limit <TOKENS>` 或环境变量 `DPSK_CONTEXT_LIMIT` 调整；`retry` 沿用原作业的值。每条带用量的助手消息都会刷新 `status.context`（`inputTokens + cacheReadTokens + cacheWriteTokens`）；第一次达到阈值时记录 `status.contextReminder` 和 `context_reminder` 事件，作业继续运行。`dsb status` 同时显示 `context` 和 `contextLimit`。

### 模型与图片

默认模型路由是 `deepseek-official`/`deepseek-flash`，可以用参数或 `DPSK_PROVIDER`/`DPSK_MODEL` 改。每次初始化 SDK 时都会明确设置路由。`--dsh-entry` 用来指定本机 dsh 的 `lib/bin.js`。

要让 dsh 看图，就重复传 `--image <文件>`：

- 只支持 JPEG、PNG、GIF、WebP，按文件内容判断，不看扩展名；
- 最多 20 张；首条消息连同文字按 base64 编码后不能超过 8 MiB；
- 图片只随首条消息发送，`dsb send` 不能带图；`dsb retry` 沿用原作业的图片，派单后图片被改动或删除时会拒绝重试。

默认的 `deepseek-flash` 支持看图。如果用 `--model` 换成不支持图片的模型，dsh 会悄悄把图片换成文字占位符。所以验收时要确认报告真的描述了图片内容，不能只看 `RESULT: OK`。

### 记录、返工与验收

```text
dsb retry <作业ID> --feedback "失败证据.md"
dsb retry <作业ID> --feedback "超时后继续.md" --resume
dsb review <作业ID> --verdict accepted --note "实际检查与测试证据"
dsb stats
```

作业、完整报告、前后 Git 状态、交互事件和用量保存在 `$DSH_HOME/bridge/jobs/<ID>/`，默认是 `~/.dsh/bridge/jobs/<ID>/`。Git 状态清单不是备份。进程状态（processState）、模型自报的结果（reportedResult）和宿主的验收结论，三者互相独立。

返工会保留原始要求和配置摘要，新开一个会话；作业保存的 brief 副本或原 MCP patch 文件变了就要求新建任务，改源 brief 文件不会触发这个检查。失败或报告不是 OK 的作业不能标为 accepted。用量只统计匹配的根会话，缺失的数据不当作零，也不代表包含全部子代理的账单。

同一个任务（共享 `rootId` 的作业）只允许 1 次返工；带 `parentId` 但没有 `retryKind` 的旧作业也算一次返工。第二次返工会被拒绝，除非命令带 `--user-ok`：宿主应先告诉用户当前状态、已经试过什么和失败证据，用户决定继续后用 `--user-ok` 重发。`--resume` 表示只继续被超时或未回答提问中断的工作，不算返工，也不受限；`retryKind` 记录为 `rework` 或 `resume`。

## 并发

默认最多同时跑 8 个作业，共享同一个 `DSH_HOME` 的启动器一起排队。`DPSK_CONCURRENCY` 或 `--concurrency` 可以设成 1–256，多个启动器的上限不同时取最小值。`dsb retry` 沿用原作业记录的上限，不读当前的 `DPSK_CONCURRENCY`。想统一提高并发，就给所有启动器设同一个环境变量。实际速度还受服务配额、机器资源和范围冲突限制，256 只是上限，不是实测吞吐。

```text
dsb run --cwd "项目" --brief "前端.md" --scope src/frontend --concurrency 32
dsb run --cwd "项目" --brief "后端.md" --scope src/backend --concurrency 32
dsb run --cwd "项目" --brief "调查.md" --read-only
dsb run --cwd "另一个项目" --brief "场景编辑.md" --resource unity-editor-main
```

- 写任务默认锁住整个 Git 工作区；不是 Git 目录时锁当前目录。
- `--scope` 可以重复，路径相对于 Git 工作区根目录。互不重叠的范围并行；有父子关系或重叠的范围排队等待。
- `--read-only` 任务之间并行，和范围重叠的写任务互斥。
- 相同的 `--resource` 跨工作区互斥，适合协调共用的编辑器或服务。

范围、只读和资源都是协作约定，不是文件系统沙箱，宿主原有的权限和 Harness 沙箱照常生效。取消和总超时都把排队时间算在内。旧版启动器不参与新的调度协议，升级前要先结束旧作业。

如果进程崩溃，或者无法确认清理成功，预约会一直保留。作业和预约是否还活着，按"记录的 PID 仍在，并且心跳文件在 60 秒内更新过"判断：启动器每 5 秒刷新一次作业目录里的心跳文件，所以 Windows 复用了 PID 也不会让旧作业一直显示为运行中；`status`、`dsv` 和 `wait` 会把心跳过期的作业当作 `unknown`/Interrupted。没有心跳文件的旧作业和旧预约仍只检查 PID。确认原任务和所有相关进程都已停止、检查过已完成的部分改动之后，才能运行 `dsb unlock <ID> --confirm-stopped`。如果启动器已按上面的规则判定为不存活，即使记录的子进程 PID 仍然存在，unlock 也会继续，并在输出的 `warning` 字段里说明这些 PID 仍存在；不能因为日志一段时间没更新，就认定进程已经停了，看到 `warning` 时要先核实里面的 PID。

## dsv 会话查看器

```text
dsv                         全屏界面
dsv ls [N]                  最近的会话
dsv show <ID|latest>        结果优先的阅读视图
dsv show <ID> --details     按时间查看完整过程
dsv show <ID> --full        不截断的原始过程
dsv watch [ID]              实时跟踪
dsv --snapshot 120x30       按界面布局输出一帧纯文本（排查界面问题用）
dsv --version
```

dsv 读取 v4 格式的明文或 zstd 压缩日志，会处理写到一半的尾部、工具结果、系统消息、结构化错误和用量。同一会话有多个版本的日志时取最新的；遇到更新的未知格式会提示该格式尚未验证。`DSH_SESSIONS_ROOT` 可以指定日志目录。

阅读视图先显示待回复的问题和最新结果，任务原文可以展开，一串工具调用合并成一行；思考、成功输出、时间戳和用量不占正文。切到过程视图后，每次工具调用和它的返回合成一条可展开的记录，计划更新按轮次汇总。有新会话出现时，不会自动切走你正在看的会话。

dsv 的界面文字是英文。界面左边是会话列表（Sessions），右边是正文（Transcript），有焦点的面板边框会高亮。启动时焦点在列表上。

列表固定分成两大组：

- **Running（运行中）**：再按状态分成 Active（5 分钟内有更新）、No updates（这一轮没结束，但超过 5 分钟没有更新）和 Just ended（刚结束）。会话结束后，不管成功与否，都会在 Just ended 里停留 2 分钟，然后移到 Finished。如果你正在看它，就一直留着；切到别的会话后再重新计时 2 分钟。超过 30 分钟没有更新的 No updates 会话多半已经中断，会直接放进 Finished，但仍然标着 No updates。
- **Finished（已完成）**：按日期分组（例如 `2026-11-2`），最近一天默认展开，更早的默认折叠。

Interrupted（已中断）是状态标签，不是单独的分组：由 dsb 派出的会话，如果日志里这一轮还没结束、但桥的作业已经不在运行（启动器被意外结束、心跳超过 60 秒没有更新，或作业被取消、失败、超时），就显示为 Interrupted，和 `dsb status` 的 `unknown` 等状态一致。它不会再继续，按"刚结束"的规则留在 Running 的 Just ended 2 分钟，然后移到 Finished。不是 dsb 派出的会话仍按日志判断。

按键：

- **列表**：↑↓ 或 j/k 选择，右边马上显示选中的会话；PgUp/PgDn 跳 5 项，g/G 或 Home/End 到首尾。组标题上按 Enter、空格或 → 展开或折叠，← 折叠所在的组；会话上按 Enter 或 → 进入正文。z 折叠全部分组，Z 展开全部分组，n 依次跳到运行中的会话。
- **正文**：↑↓ 或 j/k 按内容块移动，Enter/空格展开或收起当前块。PgUp/PgDn 翻页，高亮会跟到新的一页；Ctrl+D/Ctrl+U 滚动半页，高亮留在原来的块上（和滚轮一样）。滚动之后再按 j/k 或 Enter，会从屏幕上看得到的块继续。g 到顶，G 到底并跟随最新内容，e/E 逐块全部展开/收起，Esc 或 ← 回到列表。
- **全局**：Tab 或 Shift+Tab 切换面板，d 切换阅读/过程视图（正文框右下角显示着 `d  Reading │ Process`，也可以点），r 显示思考，f 正文全部展开（开关），s 显示系统消息，i 显示路径、ID 和用量，u 检查并安装更新，Ctrl+L 重绘屏幕，? 帮助，q 退出。自动跟随有更新的会话（a）和结束提示音（b）默认关闭；用 Enter、→、鼠标或 j/k 自己选会话时，自动跟随会关掉。
- **帮助**：窗口装不下时自动换行，可以用 ↑↓、PgUp/PgDn 或滚轮滚动，? 或 Esc 关闭。帮助打开时，键盘和鼠标都不会改动后面的界面。
- **鼠标**：可以点击会话、组标题、正文块、正文框右下角的视图切换和底栏按键；滚轮只滚动鼠标所在的面板。窄窗口里点击会话会直接进入正文。

每个会话各自记住滚动位置和展开状态。窗口不足 100 列时一次只显示一个面板。底栏放不下所有按键时，优先保留切换面板和进入（Tab、Enter），`? Help` 和 `q Quit` 始终在右边。改变窗口大小后会自动整屏重画；如果画面仍然错乱，按 Ctrl+L。

日志状态不能证明进程还活着，也不代表验收结果。列表显示最近 60 个会话，标题在后台陆续读取，不会卡住界面。单个会话上限 16 MiB 或 3 万个事件，超过时显示读取失败。解码缓存总共 64 MiB，超出时释放没在看的会话正文（列表信息保留），再打开时重新读取。

## 自动更新

```text
dsv update --check          立即检查，不安装
dsv update                  检查并安装正式更新
dsv update --auto on        开启自动更新
dsv update --auto off       关闭自动更新（默认）
```

全屏界面会在后台检查 GitHub 上最新的正式 Release，结果缓存 6 小时：界面每小时刷新一次，但联网检查最多每 6 小时一次。发现新版本时在顶栏提示，按 u 安装。检查失败不影响查看；命令行方式查看时不联网检查。设置 `NO_UPDATE_NOTIFIER=1`、处于 CI 环境或加 `--no-update-check` 都会关闭自动检查，手动运行 `dsv update` 仍然可用。

开启自动更新后，发现正式新版本时会先等桥接作业结束，再独占调度系统进行更新。最多排队 60 秒，忙的话保留提示、下次再试。更新只在以下条件下进行：origin 是官方仓库（即 `package.json` 里 `repository.url` 指向的 GitHub 仓库）、工作区干净、历史可以快进。有本地修改或分叉时暂停更新，不会强制覆盖。更新会依次安装锁定的依赖、运行检查、同步已登记宿主的 skills，完成后需要重新打开 dsv 和宿主会话。

只有用 Git 克隆并 link 安装的目录支持自动更新。失败记录在 `~/.dpsk-bridge/update-state.json`；如果代码已经快进但安装失败，按记录修复，不会自动回滚。清理失败、独占预约没释放时，先关掉原来的 dsv，确认记录里的所有进程都已退出，再运行 `dsv update --recover --confirm-stopped`。版本比较用 npm 的 [semver](https://github.com/npm/node-semver)。常见的 [update-notifier](https://github.com/sindresorhus/update-notifier) 面向 npm registry，所以本项目直接跟随 GitHub Release。

## 发布与验证

维护者先提交版本号和 lockfile 并通过 CI，再推送和 `package.json` 里 version 一致的正式 tag。`release.yml` 会检查版本、跑测试、打包并创建 GitHub Release。只有提交或 tag、没有 Release 时，不会提示用户更新。例如发布下一个补丁版本：

```text
npm version patch
git push origin main --follow-tags
```

本地验证：

```text
npm ci --ignore-scripts
npm run check
npm test
```

测试覆盖 v4 日志、消息竞态、提问和审批的完整流程、真实多进程争抢、独占更新、Git 快进与失败恢复、通用宿主安装。把 `DPSK_REAL_DSH_ENTRY` 设为当前 dsh 的入口后，`node --test test/real-dsh.test.mjs` 会在真实 Harness 上用隔离的本地模拟模型测试，不请求付费模型。
