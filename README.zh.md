# dpsk-bridge

[English](README.md) | 中文

dpsk-bridge 让宿主 agent 把边界清晰的任务委派给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`），任务运行期间宿主可以继续做别的事。宿主 agent 指任何能执行本地命令的编程助手，例如 Claude Code、Codex 或你自己写的 agent；它负责写 brief、在运行中回答问题、验收结果，dsh 在自己的 SDK 会话里完成任务。项目包含任务桥 `dsb`、会话查看器 `dsv` 和两个 skill——`deepseek-delegate` 与 `deepseek-mcp`；它不是 MCP server，也不绑定某个宿主或某个模型。

## 工作原理

1. 宿主 agent 写一份 brief：目标、已经定下来的点、如何验证结果。
2. `dsb run --brief <FILE>` 为这个作业启动一个 dsh SDK 会话，并一直挂着。
3. dsh 通过同一个 SDK 连接把提问和权限请求送回宿主。
4. 宿主用 `dsb answer` 回答，用 `dsb wait` 等待。
5. 结束后宿主读 `dsb result`，用 `dsb review` 记录验收结果。

`dsb wait` 只读本地文件，等待不消耗模型 token。只有 `run` 和 `retry` 会调用模型。

## 当前状态与要求

项目跟随 dsh 的开发者预览版快速迭代。需要 dsh 0.2.2-alpha.3 或更新版本、Node.js 24.9 或更新版本，只读取 v4 格式的会话日志，在 Windows 和 Linux 上都有测试。版本之间可能有不兼容的改动，见[更新日志](CHANGELOG.md)。

## 安装

安装脚本面向 Windows PowerShell，核心命令行在 Windows 和 Linux 上都有测试。

```powershell
git clone https://github.com/XiaoNetwork-Astral/dpsk-bridge.git
cd dpsk-bridge
.\scripts\install.ps1 -Target Claude    # 或 Codex，或 Generic -SkillsDir <DIR>
```

脚本会安装锁定版本的依赖，按需安装或升级 dsh，把 skills 同步到所选宿主，并提供 `dsb`、`dsv` 命令。每个宿主运行一次。装好后不要移动这个目录，并重新打开宿主会话，让它加载 skills。更新和卸载见[使用参考](docs/usage.md)。

没有 PowerShell 时，先运行 `npm install -g @deepseek-ai/dsh@0.2.2-alpha.3` 安装 dsh，再运行 `npm ci --ignore-scripts && npm link`，并把 `skill/deepseek-delegate` 和 `skill/deepseek-mcp` 复制到宿主加载 skill 的位置。

## 快速开始

写一份最小的 brief：

```markdown
# Task

给 `src/report.mjs` 增加 JSON 输出选项，并补上测试。
不要改变默认输出。
`npm test` 通过即完成。
```

然后把作业放到后台运行，等待它，需要时回答：

```text
dsb run --cwd <PROJECT_DIR> --brief brief.md
dsb wait <ID> --timeout 600
dsb answer <ID> --request <REQUEST_ID> --answer answer.json
dsb result <ID>
```

`dsb run` 输出的第一行带有作业 ID。把 `run` 放到后台，用 `dsb wait` 等待，不要反复查询。所有命令都是每行一个 JSON 对象；`dsb <command> --help` 列出全部参数，包括 `-C`、`-b` 这类短别名。

## 在宿主 agent 中使用

给宿主安装一次 skills，之后宿主就能自己派单。

- `deepseek-delegate`：Claude 装在 `~/.claude/skills/deepseek-delegate`，Codex 装在 `~/.agents/skills/deepseek-delegate`，Generic 装在 `<DIR>/deepseek-delegate`。它说明何时该委派、brief 要定下什么、如何等待、回答和验收。
- `deepseek-mcp`：装在同一位置。它说明如何安装、导入、验证和复用 dsh 的 MCP patch。

## dsv

`dsv` 用全屏界面读取同样的会话日志：左边是会话列表，右边是正文，按 `?` 查看全部按键。`dsv ls` 列出最近的会话，`dsv show latest` 看最新结果，`dsv watch` 跟踪正在运行的会话，`dsv update` 安装正式更新。

## 文档

- [使用参考](docs/usage.md)：全部命令和参数、等待、并发与范围、图片、MCP patch、dsv 按键、更新。
- [deepseek-delegate skill](skill/deepseek-delegate/SKILL.md) 和 [deepseek-mcp skill](skill/deepseek-mcp/SKILL.md)。

## 开发

```text
npm ci --ignore-scripts
npm run check
npm test
```

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

Copyright (C) 2026 AAAA9731。以 [LGPL-2.1](LICENSE) 发布。本项目与 Anthropic、OpenAI、DeepSeek 均无官方关联。
