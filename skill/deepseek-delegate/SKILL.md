---
name: deepseek-delegate
description: Delegate bounded coding, investigation, batch processing, or MCP tasks from any host agent with local command execution to DeepSeek Harness (dsh), with bidirectional updates and coordinated concurrency. Consider before extensive source reading, or when the user asks to use DeepSeek or a cheaper model.
---

# DeepSeek delegation (dpsk-bridge)

For any host agent that can run local commands; Claude Code and Codex are examples. The host agent understands the user's goal, sets the boundaries, answers questions during the run, and reviews the result; dsh investigates, implements, and verifies on its own. dpsk-bridge uses bidirectional SDK sessions and loads MCP servers on demand. Requires Node.js >=24.9 and `@deepseek-ai/dsh` >=0.2.1-rc.3; update to these versions first and do not use the old launch path or old job records.

## When to delegate

Decide before reading a lot of source or writing a detailed implementation. When the goal can be handed over, the scope is clear, and the result can be checked, prefer delegating work that can proceed on its own; do not finish the investigation or code generation yourself just to prepare the brief. A task that cannot be delegated as a whole can still hand off a bounded investigation, verification, or mechanical step.

| Good for dsh | Kept by the host agent |
|---|---|
| Locating relevant files, tracing call paths, scanning logs in bulk, and returning conclusions with locations | Clarifying requirements, cross-module trade-offs, and the final judgment on investigation results |
| Implementing a feature or fix following the goal and existing conventions, together with the relevant tests | Designs that need ongoing discussion; decisions that affect security or data integrity |
| Batch conversions, mechanical edits, running a known verification procedure, well-scoped MCP operations | Changes of one or two lines where dispatch and review cost more, and adjustments to existing UI code |

No existing plan, finished code, or extra plugin is required. Reference a specification if there is one; otherwise give observable completion criteria. Hard problems can start with a bounded evidence-gathering task, after which the host agent decides the next step.

Prompt engineering (writing or changing skills, system prompts, brief templates) and organizing or rewriting documentation are done by the host agent itself, not by dsh. Such changes easily look fine locally while the whole becomes inconsistent, repetitive, or confusing; someone has to read the full text.

Organize each task around one goal that can be accepted. Implementation, tests, and directly related changes that share context can go together; do not split mechanically by plan item or file count. Split when there are several independent goals, complex constraints, or decisions needed midway. Parallel tasks need separate write scopes, and the host agent must not edit files or MCP objects that dsh is working on at the same time.

## Write a short, self-contained brief

Every `dsb run` or `retry` starts a new session that cannot see the host agent's conversation. Pass only the goal, the necessary context, the boundaries, and how to verify. Point to existing specifications and large materials by path and let dsh read them; do not copy the whole conversation, source code, or implementation steps. Pass the paths of applicable conventions such as `AGENTS.md` or `CLAUDE.md`, and state the hard limits and user decisions that affect this task in the brief; do not assume dsh inherits the host's instructions, plugins, MCP configuration, or permissions.

Write the brief in English. The bridge appends a report contract to every brief that asks dsh to use standard English for its reports, progress updates, and questions; files it creates or edits still follow the project's own language and conventions.

```text
[Goal] The behavior or finding the user needs, and when it counts as done.
[Context] Project root; known entry points or reference files; project conventions that must be followed.
[Scope] Modules/directories or MCP objects that may change; behavior and existing changes to keep; task-specific limits.
[Acceptance] Relevant tests/verification commands or observable results; if unknown, let dsh find them and state the method it used.
[Report] First line RESULT: OK|FAIL|BLOCKED.
Then briefly: conclusion, changed files/evidence locations, verification commands and exit codes, anything unverified or blocking.
Keep it to about 15 lines; put detailed results or long logs in a file and give the path. Do not paste whole source files or the run.
```

Drop fields that do not apply. `OK` means the agreed acceptance criteria are met, `FAIL` means implementation or verification failed, and `BLOCKED` means a required permission, dependency, or decision is missing; verification that was not run must be stated and never reported as passed.

Before dispatching, do only light checks: the root and any named entry points exist, constraints and acceptance do not conflict, and which changes already exist in the workspace. Without an exact file list, a module scope is enough and dsh locates the files. Implementation details are dsh's choice; it returns a blocking reason when goals conflict, the scope must grow, or permissions are missing.

Delegation does not extend the user's authorization. By default dsh does not commit, push, publish, or perform deletions or dependency installs unrelated to the task. When using MCP, name the target instance, the allowed operations, and what must be saved; for stateful applications, restore only temporary settings and keep the results the task requires. Limits in the brief are task agreements and do not replace the actual sandbox and MCP permissions.

## Calling and waiting

Write the brief as UTF-8 to a suitable place for task material inside the project, and make sure the file exists before starting `dsb run`. Use this package's `dsb` launcher: it stores the original brief, a Git baseline, the report, and the exit code, and coordinates concurrency. `run` / `retry` keep running until the job ends; the host keeps the process session and serves the bidirectional requests.

The host names below are examples, not extra requirements. A host that is not listed follows the "Any host" row. Parameter names come from the tools you actually have; never pass one host's parameters to another.

| Host | Start and wait |
|---|---|
| Any host | Use the available background command or process session interface, keep the handle, wait and read updates, and check for questions and permission requests. Always wait with `dsb wait` (below); do not poll in your own loop. |
| Claude Code | Example: if the Bash tool supports `run_in_background: true`, start with it and record the background task ID; otherwise follow the "Any host" row. Read bridge events and answer requests during the run, and read the result at the end. |
| Codex | Run with the available command execution tool. If it offers `exec_command` / `write_stdin`, set a bounded `yield_time_ms`, keep the returned `session_id`, and wait for and read later output with `write_stdin`. Parameter names differ between hosts; do not mix them. |

The host's background task list shows both the host agent's own commands and dsh jobs. When starting `dsb run` / `dsb retry`, if the host lets you name or describe the background command, start it with `[dpsk-bridge]` (for example `[dpsk-bridge] Investigate the login failure`) so the user can tell at a glance what dsh is doing; if the host has no such field, skip this. The prefix belongs only in the host's task description, not in the brief.

If your command tool cannot return output while the command is still running, you cannot answer questions or approvals mid-run. Set `--timeout` to an acceptable upper limit and read the result with `dsb result <ID>` afterwards; such hosts should only dispatch tasks that need no decisions midway. If a question causes a timeout, dispatch again with `dsb retry`. That re-dispatch only resumes work interrupted by the question; it does not count as the one rework allowed after a failed review ("Review and rework").

If the host cannot wake the main agent when a background command ends, do not poll `status` or `events` in a loop; every query is a paid call. Put `dsb run` in the background or a process session and wait with `dsb wait <ID> --timeout <seconds>`: it only reads local files, returns once when the job ends, a question or approval needs an answer, or the timeout passes, and makes no model call while waiting. `--timeout` defaults to 600, ranges 1–3600, and must not exceed what the host allows for a single command. Act on the returned `reason`: on `timeout`, wait again; on `request`, handle it with `dsb events` and `dsb answer` first (`actionableRequests` lists requests not yet answered; answered ones do not return again); on `finished`, read the result, and for `cleanup_failed` deal with leftover processes per the troubleshooting guide first; `unknown` means the launcher ended unexpectedly, so confirm the process state per the troubleshooting guide instead of re-dispatching. A `wait` return only says what happened; it does not mean the task succeeded.

`dsb run` / `retry` also accept `--notify-cmd <command>` (dsb runs the command when the job ends or a new question appears, to wake the host). It has not been verified on any real host. **Do not use it for now**, and do not configure it for the user, until this skill explicitly allows it.

Example (`2700` seconds is an example limit; adjust per task; repeat `--patch <file>` when MCP is needed):

```text
dsb run --cwd "<project dir>" --brief "<brief file>" --timeout 2700
```

The default provider/model is `deepseek-official` / `deepseek-flash`; override with `--provider`, `--model`, or `DPSK_PROVIDER`, `DPSK_MODEL`, and keep any route the user specified.

To let dsh see images, repeat `--image <file>`: only JPEG, PNG, GIF, and WebP are supported (judged by content, not extension), at most 20 images, and the first message including text must not exceed 8 MiB (8388608 bytes) after base64 encoding. Images are attached to the first message only; follow-up `dsb send` messages cannot carry images. `retry` reuses the original job's images and is refused if they were changed or deleted. Image input needs a model that supports it (the default `deepseek-flash` does); if `--model` switches to a model without image support, dsh silently replaces images with text placeholders, so the host agent must check that the report actually describes the image content and cannot rely on `RESULT: OK`.

- Wait with `dsb wait` (above) and after each return handle `dsb events` and `status.pendingRequests`; do not wait only for the final completion, or dsh's questions may go unanswered. Do not poll `status` / `events` frequently. The full report and error logs stay at the returned paths; read the relevant parts when needed.
- `dsb status <ID>` shows the process record and `dsb result <ID>` the short report. `completed` only means the process exit code was 0; `reportedResult` is the model's own claim, and `acceptance` is the review result recorded by the host agent.
- Launchers that share one `DSH_HOME` run at most 8 jobs at once by default; adjust with `DPSK_CONCURRENCY` or `--max-concurrent <1..256>`. The smallest limit among the participants applies, so when raising it set the same value for every launcher. Write jobs in one workspace are mutually exclusive by default; repeat `--scope <path>` to let non-overlapping scopes run in parallel (paths relative to the Git workspace root). `--read-only` jobs run in parallel with each other and exclude overlapping write jobs; it is a cooperative declaration, not a sandbox. Repeat `--resource <name>` to serialize jobs across workspaces that share a resource. The host agent, IDEs, and other launch methods are not bound by these reservations and still need to coordinate scopes.
- A local file-system queue persists the queue state; cancellation and timeouts cover the queued phase. `unknown` and `cleanup_failed` keep the reservation, which is released only after confirming the processes stopped.
- When MCP is needed, read the first 4 lines of `~/.dsh/patches/*-mcp.yml`, check the prerequisites, and load only the needed `--patch <file>` (repeatable). Load nothing when MCP is not needed. When a verification result exists and the configuration has not changed, do not reinstall or retest connectivity. When a configuration is missing, use the `dsh-mcp` skill from the same package.
- Use the correct project root. For long paths, permissions, or locked files, read [Troubleshooting](references/troubleshooting.md) as needed; do not change the project scope or disable the sandbox to make a call work.

## Two-way messages and requests

To add context during the run, write the message to a UTF-8 file and run `dsb send <ID> --message-file <file>`. Follow-ups enter the next turn and do not interrupt the current step. After the job ends, `send` no longer works; use `retry` to continue in a new session.

Read updates with `dsb events <ID> --after <byte cursor> --limit 20`, starting from cursor `0`; keep the returned `cursor`, and call again while `more` is true. `--limit` defaults to 20 with a maximum of 200; the cursor is a byte position, not an event number. Together with `pendingRequests` from `dsb status <ID>`, this shows dsh's questions and permission requests.

Write the answer as a JSON file and run `dsb answer <ID> --request <request ID> --answer <JSON file>`. An answer to an ordinary question looks like this:

```json
{"answers":[{"id":"question ID","selected":[],"custom":"the answer"}]}
```

`id` is the question ID from the request; fill `selected` according to the request when it offers options. Permission answers are `{"outcome":"allowed-once"}`, `{"outcome":"rejected"}`, or `{"outcome":"cancelled"}`. The bridge only forwards permission decisions and cannot extend authorization; the host answers according to the user's existing authorization, and when it cannot decide it asks the user and waits. Never approve automatically.

A `queued` result from `send` / `answer` only means the input was queued; keep reading until an `input_delivered` or `input_rejected` event confirms the outcome. Answers handed to the host plugin through the file channel first show `input_forwarded` (handed over, waiting to be consumed); that is not delivery, so keep waiting for `input_delivered` or `input_rejected`. Request IDs differ from job IDs; do not answer expired requests or requests of other jobs. While handling these events, keep the process session managed and do not mistake waiting for an answer as a stall.

## Review and rework

Read the short report first, then check the evidence that matters for the acceptance criteria yourself. In a Git project, compare the state before and after dispatch and the relevant diff; otherwise check the corresponding files or MCP state. Changes the user had already made do not count as dsh's output.

- Behavior changes: check the key diff and run the smallest relevant test or reproduction; widen verification only when the scope of impact or failure evidence calls for it.
- Mechanical conversions: check counts, structure, constraints, and representative samples; verify deterministic rules with a script where possible.
- Investigations: spot-check the file locations and conclusions cited in the report; do not reread the whole repository.
- Running tests/builds: check the actual commands, exit codes, and logs/artifacts; do not rerun the full pipeline unconditionally when nothing changed and there is no evidence gap.
- MCP operations: check the final state with relevant read-only queries.

After acceptance, run `dsb review <ID> --verdict accepted --note "evidence actually checked"`; otherwise use `rework` or `blocked`. Never mark a job accepted on `OK` alone. A job whose process failed or whose report is not OK cannot be accepted; when the host agent fixes the result itself, say so separately, and it does not count as this delegation passing.

The host agent handles small corrections directly. When rework has a clear scope, write the specific failure evidence to a file, run `dsb retry <ID> --feedback <file>`, and wait the same way. The launcher keeps the original goal, working directory, and MCP configuration and creates a linked new session. Let dsh fix it once this way, then follow the next paragraph. Feedback only adds evidence and to-dos; when the user changes the goal or the MCP configuration changes, prepare a full new brief and create a new task instead of quietly changing the original scope through rework.

When dsh's work has problems, the first time you may send it back with `dsb retry` and specific failure evidence. If the problem remains after that fix, or gets worse, do not send dsh again; the host agent takes over the fix. Do not keep spending just to stay with delegation. After fixing, the host agent must run the relevant tests or verification itself; if the problem still remains, stop changing things and tell the user the current state, what was tried, and the failure evidence, and ask the user to look at it. Do not keep retrying in place. Resuming does not restore the old session's full context, so still point to the existing results and the relevant evidence.

UI tasks (interfaces, styles, interaction, terminal UIs) come in two kinds. When building from scratch, let dsh write the first version and have the host agent check it. If that version is unusable and cannot be saved by small adjustments (for example the overall structure is wrong or it does not run), dsh may rework it once through the general flow above, because a rewrite by the host agent costs too much; anything small adjustments can fix, the host agent fixes directly. When adjusting existing UI code, the host agent changes it directly instead of sending it to dsh. For UI tasks, "run the tests yourself" means actually running or rendering the result and checking how it looks and behaves, not just reading the code; if the host agent's adjustments still do not look right, stop and ask the user to look rather than piling on changes. Note the host agent's own adjustments separately in the review record; they do not count as dsh's output.

Re-dispatch only after confirming the job really exited. To stop a job, use `dsb cancel <ID>`; an accepted cancel request does not mean the job exited. For `unknown` or `cleanup_failed`, deal with leftover processes first and do not re-dispatch. dsv's "No updates" does not prove an interruption. Partial changes from an interrupted job may still be valid; check the current state before resuming. See [Troubleshooting](references/troubleshooting.md).

## Viewing the process on demand

The user can run `dsv` in a real terminal to watch the TUI without adding to the host agent's context. The host agent uses `dsv ls` and `dsv show <ID> --no-reasoning` only when the report is not enough or a failure needs investigating, and narrows the output to the relevant part first. The viewer reads v4 plain or zstd logs; `DSH_SESSIONS_ROOT` can point to the session root. With concurrent jobs or other sessions, match the ID by project, task, and time instead of blindly using `latest`.

`dsv update --check` checks the bridge's GitHub Releases, `dsv update` (or `u` in the TUI) installs a release, and `dsv update --auto on|off` controls automatic updates, which are off by default. Updates wait for bridge jobs to finish and then run exclusively, and never overwrite a checkout with local changes or diverged history; for what to do after an update, see "Viewer and updates" in [Troubleshooting](references/troubleshooting.md).

Report to the user the result, what was actually verified, and the remaining limits, and say what work the delegation took on. `dsb stats` summarizes jobs, rework, reviews, and observed session usage; missing usage is not counted as zero, and parent-session usage does not stand in for a full bill. Without comparable usage data, do not claim a specific saving in money or percentage.
