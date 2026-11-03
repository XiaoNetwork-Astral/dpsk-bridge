---
name: deepseek-delegate
description: Delegate bounded coding, investigation, batch processing, or MCP tasks from any host agent with local command execution to DeepSeek Harness (dsh), with bidirectional updates and coordinated concurrency. Consider before extensive source reading, or when the user asks to use DeepSeek or a cheaper model.
---

# DeepSeek delegation (dpsk-bridge)

This skill is for any host agent that can run local commands; Claude Code and Codex are examples. The host agent leads: it works out what the user needs, makes the decisions that shape the result, answers dsh's questions during a run, and accepts or rejects the work. dsh (DeepSeek Harness) carries out each job with its own judgment inside the scope it is given. dpsk-bridge runs dsh through bidirectional SDK sessions and loads MCP servers on demand. It requires Node.js >=24.9 and `@deepseek-ai/dsh` >=0.2.2-alpha.3; update to these first, and start jobs only through the current `dsb` launcher.

## How the work is divided

Think of the user as the client, the host agent as the lead contractor, and dsh as the team doing the work. The aim is to spend fewer of the host agent's tokens and get the work right the first time. The default DeepSeek models handle a clear task very well in one pass and are weaker at long context and multi-step reasoning, so the host agent keeps the decisions that need the whole picture, and dsh gets real freedom inside a well-bounded job.

The host agent owns:

- what the user actually needs, and when it counts as done;
- trade-offs that cross modules;
- choices the user will see or feel, such as behavior, output format, or interface;
- which existing behavior must stay as it is.

Inside its job, dsh decides which code to read, how to implement, and how to investigate local problems it meets. The brief says which points are settled; everything it leaves open is dsh's call.

| Good for dsh | Kept by the host agent |
|---|---|
| Implementing a feature or fix within a stated scope, together with its tests | Clarifying requirements and deciding user-visible behavior |
| Collecting facts: locating files, tracing call paths, scanning logs in bulk, returning findings with locations | Cross-module trade-offs and the final judgment on findings |
| Batch conversions, mechanical edits, running a known verification procedure, well-scoped MCP operations | Decisions that affect security or data integrity; one- or two-line changes, where dispatch and review cost more than the change |

No plan, finished code, or extra plugin is needed before dispatch. Reference a specification if one exists; otherwise give observable completion criteria. When a decision needs facts the host agent does not have, dispatch a job that only collects those facts, decide, then dispatch the change.

There is no fixed size limit for a job; the host agent decides, with one rule in mind: keep dsh's context short. Work that would have dsh read much of the codebase or span unrelated modules goes better as a sequence of jobs, each result feeding the next brief. Keep a change and its tests, and other pieces that share context, in one job. After each job, `usage.samples` in `dsb result` is the number of model calls and `usage.tokens` the tokens; when jobs keep running long, make the next ones smaller.

Before running jobs in parallel, give each brief its own read and write scope, so their work does not overlap in meaning. Simultaneous writes are coordinated only by `--scope` (below) and by the host agent's own care: while dsh works on files or MCP objects, the host agent leaves them to dsh.

When the work involves UI design, writing prompts, or organizing documentation, read [Special tasks](references/special-tasks.md) first.

## Write a short, self-contained brief

Every `dsb run` or `retry` starts a new session that sees only the brief. Give it the goal, the decisions already made, the scope, and how the result will be checked. Point to specifications and large material by path so dsh reads only what it needs, and condense the conversation into its decisions. Give the paths of applicable conventions such as `AGENTS.md` or `CLAUDE.md`, and state the user decisions and hard limits that apply; dsh starts with only its own instructions, plugins, MCP configuration, and permissions.

Write the brief in English. The bridge appends a report contract that asks dsh to write its reports, progress updates, and questions in standard English; files it creates or edits follow the project's own language and conventions.

```text
[Goal] What the user needs, and when it counts as done.
[Context] Project root; entry points or reference files; project conventions to follow.
[Decided] Points already settled: user-visible behavior, behavior that must stay, the approach where it matters. Everything else is left to dsh.
[Scope] What may be read and what may change (modules, directories, or MCP objects); existing changes to keep; task-specific limits.
[Acceptance] The tests, commands, or observable results that decide success, written so they can be run as they are.
[Report] First line RESULT: OK|FAIL|BLOCKED.
Then, in about 15 lines: conclusion, changed files or evidence locations, verification commands with exit codes, a "Decisions I made" list, and anything unverified or blocking. Put long results or logs in a file and give its path.
```

Drop fields that do not apply; a fact-collecting job lists exactly which facts to return in place of `[Decided]`. `OK` means the acceptance criteria are met, `FAIL` means implementation or verification failed, and `BLOCKED` means a permission, dependency, or decision is missing. A check that was not run is reported as not run.

Write the acceptance criteria before dispatching, as things the host agent can rerun afterwards: a test, a command with its expected result, or an observable state. Also check that the root and named entry points exist, that limits and acceptance criteria agree, and which changes already exist in the workspace.

How to phrase briefs, feedback, answers, and any other prompt: a model attends to whatever the text names. A list of "do not do X" keeps X in view, and in a long context the "not" is what fades first. So say what to do; bound the work by what is allowed (paths, operations, objects) instead of listing what is forbidden; and add a limit only where dsh would very likely do the thing otherwise, stating it once together with what to do instead.

Delegation keeps the user's authorization as it is. dsh does what the task needs inside its scope; committing, pushing, publishing, and deletions or dependency installs beyond the task need the user's explicit approval, and the brief says so when the user has given it. For MCP, name the target instance, the allowed operations, and what must be saved; for stateful applications, restore temporary settings and keep the results the task needs. Limits in the brief are agreements; the sandbox and MCP permissions are the actual enforcement.

## Questions during a run

The bridge tells dsh to ask the host agent with its question tool, and wait for the answer, when the settled decisions do not fit the code it finds, when two reasonable approaches would give results the user would notice as different, or when the work needs a wider scope. Everything else dsh settles itself and lists in its report.

Answer briefly: the decision, with a short reason when it helps dsh continue. dsb allows 3 answered questions per job (permission answers are not counted); a fourth means the job is less bounded than planned, so `dsb wait` returns `escalate` and `dsb answer` refuses it. Tell the user what is going on; if the user decides to continue, answer with `--user-ok`, which lifts the cap for that job.

## Calling and waiting

Write the brief as UTF-8 to a place for task material inside the project, and confirm the file exists before starting `dsb run`. Brief, feedback, message, and answer files are each limited to 48000 bytes. Use this package's `dsb` launcher: it stores the original brief, a Git baseline, the report, and the exit code, and coordinates concurrency. `run` / `retry` keep running until the job ends; the host keeps the process session and serves the bidirectional requests.

The host names below are examples. A host that is not listed follows the "Any host" row. Parameter names come from the tools you actually have; use each host's own.

| Host | Start and wait |
|---|---|
| Any host | Use the available background command or process session interface, keep the handle, and wait with `dsb wait` (below), handling questions and permission requests after each return. |
| Claude Code | Example: if the Bash tool supports `run_in_background: true`, start with it and record the background task ID; otherwise follow the "Any host" row. Read bridge events and answer requests during the run, and read the result at the end. |
| Codex | Run with the available command execution tool. If it offers `exec_command` / `write_stdin`, set a bounded `yield_time_ms`, keep the returned `session_id`, and read later output with `write_stdin`. |

The host's background task list shows both the host agent's own commands and dsh jobs. When the host lets you name or describe the background command for `dsb run` / `dsb retry`, start the description with `[dpsk-bridge]` (for example `[dpsk-bridge] Investigate the login failure`) so the user can tell at a glance what dsh is doing. The prefix belongs in the host's task description only, outside the brief.

If your command tool can return output only after the command ends, you cannot answer questions or approvals mid-run. Set `--timeout` to an acceptable upper limit, read the result with `dsb result <ID>` afterwards, and dispatch only tasks that need no decisions midway. If a question causes a timeout, dispatch again with `dsb retry --resume`, which resumes the interrupted work and does not count as the task's rework ("Review and rework").

Wait with `dsb wait <ID> --timeout <seconds>`, with `dsb run` in the background or a process session. It reads only local files and makes no model call; it returns once when the job ends, when a request needs an answer or the user's decision, when the job's context reaches its reminder threshold, or when the timeout passes. Each `status` or `events` check costs the host agent a turn, so use `wait` for waiting and those commands for reading after it returns. `--timeout` defaults to 600, ranges 1–3600, and must fit within what the host allows for a single command. Act on the returned `reason`:

- `timeout`: wait again.
- `request`: handle it with `dsb events` and `dsb answer` first. `actionableRequests` lists requests not yet answered; answered ones do not return again.
- `escalate`: dsh asked a question past the job's cap (see "Questions during a run"); bring it to the user.
- `context`: the job's context reached the reminder threshold (200000 tokens by default; `dsb run --context-limit <TOKENS>` or `DPSK_CONTEXT_LIMIT`). The job keeps running and the reminder comes once. Check `context` in `dsb status <ID>` and decide whether to let it finish, narrow it with a short `dsb send`, or cancel and split the remaining work into smaller jobs.
- `finished`: read the result. For `cleanup_failed`, deal with leftover processes per the troubleshooting guide first.
- `unknown`: the launcher ended unexpectedly; confirm the process state per the troubleshooting guide before anything else.

A `wait` return says what happened, not whether the task succeeded.

`dsb run` / `retry` also accept `--notify-cmd <command>` (dsb runs the command when the job ends or a new question appears, to wake the host). It is experimental and unverified on real hosts, so leave it unset, for yourself and for the user, until this skill says otherwise.

Example (`2700` seconds is an example limit; adjust per task; repeat `--patch <file>` when MCP is needed):

```text
dsb run --cwd "<project dir>" --brief "<brief file>" --timeout 2700
```

The default provider/model is `deepseek-official` / `deepseek-flash`; override with `--provider`, `--model`, or `DPSK_PROVIDER`, `DPSK_MODEL`, and keep any route the user specified.

To let dsh see images, repeat `--image <file>`. Supported formats are JPEG, PNG, GIF, and WebP (judged by content, not extension), at most 20 images, and the first message including text must stay within 8 MiB (8388608 bytes) after base64 encoding. Images go with the first message only; follow-up `dsb send` messages carry text. `retry` reuses the original job's images and is refused if they were changed or deleted. Image input needs a model that supports it (the default `deepseek-flash` does); a model without image support silently gets text placeholders instead, so check that the report actually describes the image content rather than relying on `RESULT: OK`.

- After each `wait` return, handle `dsb events` and `status.pendingRequests`, so dsh's questions get answered during the run. The full report and error logs stay at the returned paths; read the relevant parts when needed.
- `dsb status <ID>` shows the process record and `dsb result <ID>` the short report. `completed` only means the process exit code was 0; `reportedResult` is the model's own claim, and `acceptance` is the review result recorded by the host agent.
- Launchers that share one `DSH_HOME` run at most 8 jobs at once by default; adjust with `DPSK_CONCURRENCY` or `--max-concurrent <1..256>`. The smallest limit among the participants applies, so when raising it set the same value for every launcher. Write jobs in one workspace exclude each other by default; repeat `--scope <path>` to let non-overlapping scopes run in parallel (paths relative to the Git workspace root). `--read-only` jobs run in parallel with each other and exclude overlapping write jobs; it is a cooperative declaration, not a sandbox. Repeat `--resource <name>` to serialize jobs across workspaces that share a resource. The host agent, IDEs, and other launch methods sit outside these reservations and coordinate scopes themselves.
- A local file-system queue persists the queue state; cancellation and timeouts cover the queued phase. `cleanup_failed` jobs, and `unknown` jobs that had already started, keep their reservation until the host confirms the processes stopped (see Troubleshooting); a reservation still queued when its launcher disappeared is cleared automatically.
- When MCP is needed, read the first 4 lines of `*-mcp.yml` in `$DSH_HOME/patches` (`~/.dsh/patches` when `DSH_HOME` is unset), check the prerequisites, and load only the needed `--patch <file>` (repeatable); jobs without MCP load none. When a verification result exists and the configuration is unchanged, reuse it as it is. When a configuration is missing, use the `deepseek-mcp` skill from the same package.
- Use the correct project root. For long paths, permissions, or locked files, read [Troubleshooting](references/troubleshooting.md); keep the project scope and the sandbox as they are while fixing the call.

## Two-way messages and requests

To add context during the run, write the message to a UTF-8 file and run `dsb send <ID> --message-file <file>`. Follow-ups enter the next turn without interrupting the current step. Keep them short and few, since each one lengthens the session; when the plan itself changes, cancel and dispatch a new brief. After the job ends, `send` stops working; use `retry` to continue in a new session.

Read updates with `dsb events <ID> --after <byte cursor> --limit 20`, starting from cursor `0`; keep the returned `cursor`, and call again while `more` is true. `--limit` defaults to 20 with a maximum of 200; the cursor is a byte position, not an event number. Together with `pendingRequests` from `dsb status <ID>`, this shows dsh's questions and permission requests.

Write the answer as a JSON file and run `dsb answer <ID> --request <request ID> --answer <JSON file>`. An answer to an ordinary question looks like this:

```json
{"answers":[{"id":"question ID","selected":[],"custom":"the answer"}]}
```

`id` is the question ID from the request; include every question of the request exactly once. `selected` is an array of strings, filled according to the request when it offers options; `custom` is optional. Permission answers are `{"outcome":"allowed-once"}`, `{"outcome":"rejected"}`, or `{"outcome":"cancelled"}`. The bridge only forwards permission decisions and cannot extend authorization. The host answers each request according to the user's existing authorization, and when that does not settle it, asks the user and waits.

A `queued` result from `send` / `answer` only means the input was queued; keep reading until an `input_delivered` or `input_rejected` event confirms the outcome. Answers handed to the host plugin through the file channel first show `input_forwarded` (handed over, waiting to be consumed); keep waiting past it for `input_delivered` or `input_rejected`. Request IDs differ from job IDs; answer only current requests of the job at hand. While a job waits for an answer it is waiting, not stalled; keep the process session managed.

## Review and rework

Rerun the acceptance criteria yourself, then go through the decisions dsh listed in its report and check that each fits what the user wants. Read code only where the criteria do not reach, and only the relevant section. Changes the user had already made are not dsh's output; in a Git project, compare against the state before dispatch.

- Behavior changes: rerun the tests or reproduction from the acceptance criteria; widen verification only when the scope of impact or failure evidence calls for it.
- Mechanical conversions: check counts, structure, constraints, and representative samples; verify deterministic rules with a script where possible.
- Investigations: spot-check the file locations and conclusions cited in the report.
- Running tests/builds: check the actual commands, exit codes, and logs or artifacts; rerun the full pipeline only when something changed or evidence is missing.
- MCP operations: check the final state with relevant read-only queries.

After acceptance, run `dsb review <ID> --verdict accepted --note "evidence actually checked"`; otherwise use `rework` or `blocked`. Accept on checked evidence; `OK` is the model's own claim. A job whose process failed or whose report is not OK stays unaccepted; when the host agent repairs the result, record that separately as the host agent's work.

When something is wrong:

1. A small mistake: the host agent fixes it directly and notes this in the review.
2. The wrong direction: the host agent finds out why, from the relevant evidence or with a read-only job that only collects facts. It then writes the correct approach into the feedback as settled decisions, leaves dsh less to decide this time, and sends the job back once with `dsb retry <ID> --feedback <file>`, waiting the same way. The launcher keeps the original goal, working directory, and MCP configuration and creates a linked new session; it does not restore the old session's context, so point to the existing results and evidence.
3. If the rework still misses: tell the user the current state, what was tried, and the failure evidence. The user decides what happens next.

dsb allows one rework per task: a second `dsb retry` on the same task is refused, and runs only with `--user-ok` once the user has decided to continue. A retry that only resumes work interrupted by a timeout or an unanswered question uses `--resume` and is not counted. Feedback adds evidence and decisions within the original goal; when the user changes the goal or the MCP configuration changes, write a full new brief and start a new task.

Re-dispatch only after confirming the job really exited. To stop a job, use `dsb cancel <ID>`; an accepted cancel request does not yet mean the job exited. For `unknown` or `cleanup_failed`, deal with leftover processes before anything else. dsv's "No updates" is not proof of an interruption. Partial changes from an interrupted job may still be valid; check the current state before resuming. See [Troubleshooting](references/troubleshooting.md).

## Viewing the process on demand

The user can run `dsv` in a real terminal to watch the TUI without adding to the host agent's context. The host agent uses `dsv ls` and `dsv show <ID> --no-reasoning` only when the report is not enough or a failure needs investigating, and narrows the output to the relevant part first. The viewer reads v4 plain or zstd logs; `DSH_SESSIONS_ROOT` can point to the session root. With concurrent jobs or other sessions, match the ID by project, task, and time rather than taking `latest`.

`dsv update --check` checks the bridge's GitHub Releases, `dsv update` (or `u` in the TUI) installs a release, and `dsv update --auto on|off` controls automatic updates, which are off by default. Updates wait for bridge jobs to finish and then run exclusively, and leave a checkout with local changes or diverged history untouched; for what to do after an update, see "Viewer and updates" in [Troubleshooting](references/troubleshooting.md).

Report to the user the result, what was actually verified, and the remaining limits, and say what work the delegation took on. `dsb stats` summarizes jobs, rework, reviews, and observed session usage; missing usage is not counted as zero, and parent-session usage does not stand in for a full bill. Claim a specific saving in money or percentage only with comparable usage data.
