# dpsk-bridge

[English](README.md) | 中文

dpsk-bridge 让宿主 agent 把边界清晰的任务交给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`），任务运行期间宿主可以继续工作。宿主 agent 是任何能执行本地命令的编程助手——Claude Code、Codex，或你自己写的 agent：它写 brief、回答提问和权限审批、验收结果，dsh 在自己的 SDK 会话里完成任务。项目提供任务桥 `dsb`、会话查看器 `dsv`，以及 `deepseek-delegate` 和 `deepseek-mcp` 两个 skill；它不是 MCP server，也不绑定某个宿主或模型。

## 工作原理

1. 宿主 agent 写一份 brief：目标、已经定下来的点、如何验证结果。
2. `dsb run --brief <FILE>` 为这个作业启动一个 dsh SDK 会话，并一直挂着。
3. dsh 通过同一个 SDK 连接把提问和权限请求送回宿主。
4. 宿主用 `dsb answer` 回答，用 `dsb wait` 等待。
5. 结束时宿主读 `dsb result`，用 `dsb review` 记录验收结果。

`dsb wait` 只读本地文件，等待不消耗模型 token；只有 `run` 和 `retry` 会调用模型。

## 要求

- Node.js 24.9 或更新版本、npm 和 Git。
- 安装脚本会在 `dsh` 缺失时安装，在低于 `package.json` 里的最低版本（`dshVersion`，当前是 0.2.2-alpha.3）时升级；更新的版本保持不变。
- dsh 仍是开发者预览版，版本之间可能有不兼容的改动，见[更新日志](CHANGELOG.md)。桥只读取 v4 格式的会话日志，在 Windows 和 Linux 上都有测试。

## 安装

Windows（PowerShell）：

```powershell
irm https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.ps1 | iex
```

Linux 和 macOS：

```bash
curl -fsSL https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.sh | bash
```

没有指定目标、也还没有装过宿主时，安装脚本会从 `~/.claude` 识别 Claude，从 `~/.agents` 或 `~/.codex` 识别 Codex。用逗号分隔的 `DPSK_TARGET` 明确选择宿主；其他宿主用 `Generic` 加绝对路径的 `DPSK_SKILLS_DIR`：

```powershell
$env:DPSK_TARGET = 'Claude,Codex'; irm https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.ps1 | iex
$env:DPSK_TARGET = 'Generic'; $env:DPSK_SKILLS_DIR = 'C:\agent\skills'; irm https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.ps1 | iex
```

```bash
curl -fsSL https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.sh | DPSK_TARGET=Claude,Codex bash
curl -fsSL https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.sh | DPSK_TARGET=Generic DPSK_SKILLS_DIR=/agent/skills bash
```

一行命令用环境变量选择宿主。从克隆的仓库运行时，把参数交给脚本：

```powershell
.\installer.ps1 -Target Claude
```

```bash
./installer.sh install --target Claude
```

脚本会安装锁定版本的依赖，安装或升级 `dsh`，把 skills 同步到每个宿主，并全局链接 `dsb` 和 `dsv`。没有现成检出时，它会 clone 最新 Release 到 `~/.dpsk-bridge/app`；可以用 `DPSK_INSTALL_DIR`、Windows 的 `-InstallDir` 或 Linux/macOS 的 `--install-dir` 改这个位置。不要移动检出目录，并重新打开宿主会话，让它加载 skills。

## 升级

用升级动作运行安装脚本。管道方式：

```powershell
$env:DPSK_ACTION = 'upgrade'; irm https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.ps1 | iex
```

```bash
curl -fsSL https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.sh | DPSK_ACTION=upgrade bash
```

从克隆的仓库：

```powershell
.\installer.ps1 -Action upgrade
```

```bash
./installer.sh upgrade
```

升级会把检出快进到最新的 GitHub Release 并重新安装；需要时也会升级 `dsh`。它要求官方检出且没有本地改动。之后的版本可以用 `dsv update` 在终端更新，或在查看器里按 `u` 安装可用更新。

从 0.4.x 升级：运行一次上面的升级命令即可。它会顺着 `dsb`/`dsv` 的链接找到原来的检出，原地快进到新版本，升级 `dsh` 并重新同步 skills；已登记的宿主和 skill 备份都会保留。0.5.0 重命名了命令选项，[更新日志](CHANGELOG.md)列出了替代项。

## 卸载

卸载一个宿主，或卸载所有宿主和共享命令。

```powershell
$env:DPSK_ACTION = 'uninstall'; $env:DPSK_TARGET = 'Claude'; irm https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.ps1 | iex
$env:DPSK_ACTION = 'uninstall'; $env:DPSK_UNINSTALL_ALL = '1'; irm https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.ps1 | iex
```

```bash
curl -fsSL https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.sh | DPSK_ACTION=uninstall DPSK_TARGET=Claude bash
curl -fsSL https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.sh | DPSK_ACTION=uninstall DPSK_UNINSTALL_ALL=1 bash
```

从克隆的仓库运行时，可以用 `.\installer.ps1 -Action uninstall -Target Claude`、`.\installer.ps1 -Action uninstall -All`、`./installer.sh uninstall --target Claude` 或 `./installer.sh uninstall --all`。卸载最后一个宿主时也会删除 `dsb`/`dsv` 链接和安装记录；还有其他宿主时，链接和安装记录都会保留。

卸载只删除 dpsk-bridge 安装的 skills，并把它们备份到 `~/.dpsk-bridge/backups/`。`dsh`、凭据、MCP patch、作业历史和状态文件都会保留。检出目录也会保留：不再需要时，手动删除 `~/.dpsk-bridge/app`（或你 clone 的目录）。

## 使用 dsb

一份最小的 brief：

```markdown
# Task

Add a JSON output option to `src/report.mjs` and a test for it.
Do not change the default output.
Done when `npm test` passes.
```

把 `run` 放到后台，然后等待；需要时回答，最后读结果并记录验收：

```text
dsb run --cwd <PROJECT_DIR> --brief brief.md
dsb wait <ID> --timeout 600
dsb status <ID>
dsb answer <ID> --request <REQUEST_ID> --answer answer.json
dsb result <ID>
dsb review <ID> --verdict accepted --note "npm test passes"
```

`dsb run` 的第一行输出作业 ID，并一直挂到作业结束。把它放到后台，用 `dsb wait` 等待，不要反复查询。`dsb status` 显示进程状态、验收结论和待处理请求；`dsb events` 分页读取事件日志。除 help 和 version 外，所有命令都按行输出 JSON 对象；出错时输出 `{"error":"..."}` 并以 1 退出。只有作业完成且报告里是 `RESULT: OK` 时，`dsb run` 和 `dsb retry` 才以 0 退出。

### 等待

`dsb wait <ID>` 返回一个 JSON 对象，包含 `reason`、作业状态字段和 `actionableRequests`。

| `reason` | 含义 | 处理 |
|---|---|---|
| `finished` | 作业进入终态，包括 `cleanup_failed`。 | 读 `dsb result` 并验收。 |
| `request` | 有提问或审批等待回答。 | 按 `actionableRequests` 里的请求 ID 回答；详情在 `pendingRequests`。 |
| `escalate` | 只剩提问，且已达到 3 次提问上限。 | 先告诉用户；用户同意后加 `--user-ok` 回答。 |
| `context` | 上下文达到提醒阈值；每个作业只返回一次。 | 检查进度，用 `dsb send` 收窄范围，或用 `dsb cancel` 取消。 |
| `timeout` | 等待超时；作业仍在运行或排队。 | 再次等待。 |
| `unknown` | 启动器已不在或心跳过期。 | 先查 `dsb status` 和进程，再决定是否 `dsb unlock`。 |

### 回答提问与审批

每个问题恰好回答一次；`selected` 是字符串数组（自由回答用空数组），`custom` 可选：

```json
{"answers":[{"id":"question-id","selected":["Option A"],"custom":"extra context"}]}
```

审批回答是以下三种结果之一：

```json
{"outcome":"allowed-once"}
```

需要时把 `{"outcome":"allowed-once"}` 换成 `{"outcome":"rejected"}` 或 `{"outcome":"cancelled"}`。桥只原样转发回答，`dsb` 不会自行授予权限。

### 上限

- 每个作业最多回答 3 个提问。第 4 个回答会被拒绝，`dsb wait` 返回 `escalate`。用户同意继续后，用 `--user-ok` 重新执行 `dsb answer`，该作业的提问上限即解除。审批不计入。
- 每个任务只能返工 1 次。第二次 `dsb retry` 会被拒绝，除非用户同意并加 `--user-ok`。如果工作中断是由超时或未回答的提问造成的，`dsb retry --resume` 会重试，且不计为返工。
- 上下文提醒在上下文达到 200000 token 时触发一次。可用 `dsb run --context-limit <TOKENS>` 或 `DPSK_CONTEXT_LIMIT` 调整；`retry` 沿用原作业的值。

### 并发与范围

默认最多同时运行 8 个作业；共享同一个 `DSH_HOME` 的启动器共用这个上限，有效值是所有配置中的最小值。用 `--concurrency` 或 `DPSK_CONCURRENCY`（1–256）设置；`retry` 沿用原值。

`--scope` 是可重复、相对于工作区的写范围。重叠或父子范围会排队，不相交的范围可以并行。它是协作约定，不是沙箱。`--read-only` 声明任务不修改任何东西，只读任务之间可以并行；如果与写任务的范围重叠，仍会冲突，除非给它一个不相交的 `--scope`。`--resource` 按名字跨工作区加锁，用于共享编辑器、服务或 MCP 实例。

### 环境变量

| 变量 | 用途 | 默认值 |
|---|---|---|
| `DPSK_PROVIDER` | `dsb run` 的模型路由 | `deepseek-official` |
| `DPSK_MODEL` | `dsb run` 的模型名 | `deepseek-flash` |
| `DPSK_CONCURRENCY` | 启动器共享的并发作业上限 | `8` |
| `DPSK_CONTEXT_LIMIT` | 上下文提醒阈值，单位 token | `200000` |
| `DSH_HOME` | dsh 主目录；桥作业在 `$DSH_HOME/bridge` | `~/.dsh` |

命令行选项优先于对应的 `DPSK_*` 变量，`dsb retry` 沿用原作业的值。`dsb <command> --help` 会列出全部选项、默认值和短别名（例如 `-C`、`-b`、`-t`）。

详细的委派流程在 skills 里：[deepseek-delegate](skill/deepseek-delegate/SKILL.md) 说明如何写 brief、等待、回答和验收；[deepseek-mcp](skill/deepseek-mcp/SKILL.md) 说明如何安装和复用 MCP patch。

## dsv

`dsv` 用全屏界面读取同样的会话日志。`dsv ls [N]` 列出最近的会话，`dsv show [ID|latest]` 先显示结果，`dsv watch [ID]` 跟踪正在运行的会话，`dsv update` 安装更新。没有终端时，直接运行 `dsv` 会打印列表。

按 `?` 查看全部按键。三个常用的：`d` 在阅读视图和完整过程之间切换，`u` 安装可用更新，`q` 退出。

## 故障处理

| 现象 | 处理 |
|---|---|
| 作业一直 `queued`。 | 检查并发上限、重叠的 `--scope` 范围和同名 `--resource` 的持有者。排队时间也计入 `--time-limit`。 |
| `dsb wait` 返回 `unknown`，或作业是 `cleanup_failed`。 | 检查进程和已产生的部分改动。确认原任务及其子进程都已停止后，用 `dsb unlock <ID> --confirm-stopped` 释放预约。`cleanup_failed` 的作业不能重试或验收；新建 `dsb run`。 |
| `reportedResult` 是 `UNKNOWN`。 | 最后一条回复的前 10 行里没有 `RESULT: OK`、`RESULT: FAIL` 或 `RESULT: BLOCKED`。读 `report.txt`，按实际验证结果记录验收。 |
| 找不到 dsh 或版本过低。 | 运行安装脚本的升级；它会安装 `package.json` 里的最低版本。自定义构建可以用 `dsb run --dsh-entry` 指向它的 `lib/bin.js`。 |
| `dsb` 不在 PATH 上。 | 打开新终端。仍然找不到时，把 npm 的全局 bin 目录加入 PATH；安装脚本会打印该目录。 |

## 开发

```text
npm ci --ignore-scripts
npm run check
npm test
```

`npm run check` 检查源码语法；`npm test` 运行全部测试。真实 dsh 集成测试默认跳过，除非 `DPSK_REAL_DSH_ENTRY` 指向 dsh 的 `lib/bin.js`：

```powershell
$env:DPSK_REAL_DSH_ENTRY = "C:\path\to\node_modules\@deepseek-ai\dsh\lib\bin.js"
node --test test/real-dsh.test.mjs
```

```bash
DPSK_REAL_DSH_ENTRY=/path/to/node_modules/@deepseek-ai/dsh/lib/bin.js node --test test/real-dsh.test.mjs
```

发布就是推送与 `package.json` 一致的稳定 `v<version>` tag。发布工作流会测试、打包，并把 tarball、`installer.ps1`、`installer.sh` 和校验和作为 Release 资源发布。

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

Copyright (C) 2026 AAAA9731。以 [LGPL-2.1](LICENSE) 发布。本项目与 Anthropic、OpenAI、DeepSeek 均无官方关联。
