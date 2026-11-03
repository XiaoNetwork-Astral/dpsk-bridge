# dpsk-bridge

[English](README.md) | 中文

dpsk-bridge 让能执行本地命令的编程助手（Claude Code、Codex 或其他 agent）把任务委派给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`），并在任务执行期间来回交换问题、回复和追加要求。

项目包含任务桥 `dsb`、会话查看器 `dsv` 和两个 skill。它不是 MCP server。

## 当前状态

项目跟随 dsh 的开发者预览版快速迭代，需要 dsh ≥ 0.2.1-rc.3，只读取 v4 格式的会话日志。版本之间可能有不兼容的改动。

## 安装

需要 Node.js ≥ 24.9、Git、npm。安装脚本面向 Windows PowerShell，核心命令行在 Windows 和 Linux 上都有测试。

```powershell
git clone https://github.com/XiaoNetwork-Astral/dpsk-bridge.git
cd dpsk-bridge
.\scripts\install.ps1 -Target Claude   # 或 Codex，或 Generic -SkillsDir <目录>
```

脚本会安装依赖和 dsh，同步 skills，并提供 `dsb`/`dsv` 命令。装好后不要移动这个目录，并重新打开宿主会话。

没有 PowerShell 时，先运行 `npm install -g @deepseek-ai/dsh@0.2.1-rc.3` 安装 dsh，再运行 `npm ci --ignore-scripts && npm link`，并把 `skill/` 下的两个目录复制到宿主加载 skill 的位置。

## 使用

### 委派任务：dsb

```text
dsb run --cwd <项目> --brief brief.md      # 一直挂着，直到作业结束
dsb wait <作业ID>                           # 等到结束、需要回复或超时
dsb events <作业ID> --after <游标>          # 读取新的进展和问题
dsb answer <作业ID> --request <ID> --answer reply.json
dsb review <作业ID> --verdict accepted --note "验收证据"
```

把 `run` 放到后台，用 `dsb wait` 等待，不要反复查询：`wait` 只读本地文件，不调用模型。只有 `run` 和 `retry` 会调用模型。所有输出都是每行一个 JSON 对象。完整参数见 `dsb --help` 和 `dsb <命令> --help`。

### 查看会话：dsv

```text
dsv                     全屏界面
dsv ls                  最近的会话
dsv show latest         最新会话的结果
dsv update              检查并安装正式更新
```

全屏界面（英文界面）左边是会话列表，分成 Running 和 Finished（按日期）两组，右边是正文。所有操作都可以只用键盘完成，按 `?` 查看全部按键。

## 文档

- [使用参考](docs/usage.md)：等待机制、并发与范围、图片、实验功能、dsv 按键、自动更新、发布流程
- [deepseek-delegate skill](skill/deepseek-delegate/SKILL.md)：宿主应如何派单、等待和验收

## 开发

```text
npm ci --ignore-scripts
npm run check
npm test
```

## 许可证

Copyright (C) 2026 AAAA9731。以 [LGPL-2.1](LICENSE) 发布。本项目与 Anthropic、OpenAI、DeepSeek 均无官方关联。
