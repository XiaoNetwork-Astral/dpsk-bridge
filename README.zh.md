# dpsk-bridge

[English](README.md) | 中文

`dpsk-bridge` 用于让宿主 Agent（如 Claude Code、Codex 或其他本地编程助手）将边界清晰的子任务委派给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）后台执行，期间宿主可以继续处理其他工作

## 开发者预览

上游 `dsh` 仍处于开发者预览阶段，版本间可能存在不兼容变更，详见[更新日志](CHANGELOG.md)

本项目需要 **Node.js 24.9+**、**npm** 和 **Git**，仅支持读取 v4 格式的会话日志

## 安装

运行下列命令即可将本项目安装到所有受支持的 harness 中：

**Linux / macOS：**

```bash
curl -fsSL https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.sh | bash
```

**Windows (PowerShell)：**

```powershell
irm https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.ps1 | iex
```

## 卸载

运行下列命令即可从所有受支持的 harness 当中卸载本项目：

**Linux / macOS：**

```bash
curl -fsSL https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.sh | bash -s -- uninstall
```

**Windows (PowerShell)：**

```powershell
& ([scriptblock]::Create((irm https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/installer.ps1))) uninstall
```

## 清理（仅推荐特殊情况使用）

清理脚本会自动找到并移除 `dsb`、`dsv`，删除受支持的 harness 目录中属于本项目的 Skills：

```bash
curl -fsSL https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/cleanup.sh | bash
```

```powershell
irm https://github.com/XiaoNetwork-Astral/dpsk-bridge/releases/latest/download/cleanup.ps1 | iex
```

## 使用方法

在正常使用中，宿主 Agent 会通过内置 Skill 自动调用 `dsb` 完成委派：

- [deepseek-delegate](skill/deepseek-delegate/SKILL.md)：定义如何编写任务简报、等待进度、回答提问与审批、以及结果验收
- [deepseek-mcp](skill/deepseek-mcp/SKILL.md)：说明如何安装和复用 MCP 补丁

### 命令行工作流（`dsb`）

如需手动调试或在自定义 Agent 中集成，基本流程如下：

```bash
dsb run --cwd <PROJECT_DIR> --brief brief.md   # 启动后台会话，首行输出作业 ID
dsb wait <ID> --timeout 600                    # 阻塞等待本地状态变更（不消耗模型 token）
dsb answer <ID> --request <REQ_ID> --answer answer.json  # 回答提问或权限审批
dsb result <ID>                                # 读取最终报告
dsb review <ID> --verdict accepted --note "npm test passes" # 记录验收结果
```

完整的命令参数、JSON 格式与缩写请查看 `dsb <command> --help`

### 会话查看器（`dsv`）

`dsv` 提供全屏终端界面，用于实时查看和回放会话日志：

```bash
dsv ls [N]             # 列出最近会话
dsv show [ID|latest]   # 查看指定会话结果
dsv watch [ID]         # 实时跟踪运行中的会话
dsv update             # 检查并安装更新
```

在界面中按 `?` 查看快捷键说明（常用：`d` 切换简略/完整视图，`u` 安装更新，`q` 退出）

### 常用环境变量

命令行参数优先级高于环境变量，`dsb retry` 默认沿用原作业配置：

| 变量                 | 说明                                        | 默认值              |
| -------------------- | ------------------------------------------- | ------------------- |
| `DPSK_PROVIDER`      | 模型服务商路由                              | `deepseek-official` |
| `DPSK_MODEL`         | 模型名称                                    | `deepseek-flash`    |
| `DPSK_CONCURRENCY`   | 共享并发作业上限（1–256）                   | `8`                 |
| `DPSK_CONTEXT_LIMIT` | 上下文提醒阈值（token）                     | `200000`            |
| `DSH_HOME`           | `dsh` 主目录（作业存于 `$DSH_HOME/bridge`） | `~/.dsh`            |

## 许可证

Copyright (C) 2026 AAAA9731 & BlueFunny，基于 [LGPL-2.1](LICENSE) 许可证发布

本项目与 Anthropic、OpenAI、DeepSeek 均无官方关联
