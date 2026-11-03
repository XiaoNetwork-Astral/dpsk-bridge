# Troubleshooting

Read this only when a call fails, a job makes no progress for a long time, or work needs to be resumed.

| Symptom | What to do |
|---|---|
| The job waits for an answer to a question or permission request | Read `pendingRequests` from `dsb status <ID>` and `dsb events <ID>`, then answer with `dsb answer`. Approve only operations the user's existing authorization covers; when you cannot decide, ask the user. Never disable the sandbox to get around an approval. |
| `send` / `answer` returned `queued` but nothing changes | Queued is not delivered. Keep the returned input ID and page through events for the matching `input_delivered` / `input_rejected`; check whether the request was cancelled if needed. `input_forwarded` (handed to the host plugin) is not delivery either. Follow-ups enter the next turn and do not interrupt the current step. |
| The job stays `queued` | Check the concurrency limit (see "Calling and waiting" in SKILL.md), scope conflicts in the same workspace, and holders of the same `--resource`. Do not claim read-only or shrink the write scope to jump the queue. Cancellation and timeouts include the queued time. |
| Unsupported Node.js, dsh, or job version | Update to Node.js >=24.9, `@deepseek-ai/dsh` >=0.2.1-rc.3, and the current bridge. Only the current SDK, v4 sessions, and the current job format are supported; do not mix with old launchers. |
| `detected dubious ownership` | After confirming this is the authorized project, use `git -c safe.directory='<project path>' ...` for that Git command. Do not change the global trust configuration. |
| `cannot modify ...: file has not been read` | Read an existing file before overwriting it, and check whether another process changed it. |
| Windows: `ReplaceFileW EIO (Win32 1175)` or other file-lock IO errors | Check the file's current content and who holds it. Once the failure is confirmed to be temporary, retry the affected step and verify what was actually written; do not blindly rerun the whole task. |
| `cannot read ...: not found` | Check the path and the working directory. A moved file may be located within the authorized scope; if the right target cannot be confirmed, report it as blocked. |
| exit 126 `path longer than allowed` | Check the length of the working directory. Use an existing short path into the same authorized project, or let the host agent handle it; do not copy or move the repository, or run in another project. |
| The job fails right away with ENOENT for the brief | The brief file was not on disk yet when `dsb run` started. Confirm the file exists, then start again; no job was created, so this does not count as a rework. |
| `invalid config` / MCP fails to start | Use the `dsh-mcp` skill to check the loaded patch, its dependencies, and required environment variables. Never print credentials in diagnostic output. |

## Confirming that a job ended

Check `dsb status <ID>` and the host's process session and exit code first; Claude Code background tasks and Codex command sessions are only examples. A process handle returned by the host tool only means the command is still running; it does not mean the task is done. Keep the handle, wait with `dsb wait`, and handle requests and updates after each return. dsv's "Running / No updates" only describes the log: five minutes without new log lines may just be a long command or a pending question, so it cannot tell whether the process ended.

`dsb cancel <ID>` returns once the cancel request is queued. Re-dispatch only after the job reaches `cancelled`. `cleanup_failed` means cleanup of the process tree was not confirmed, and `unknown` means the launcher ended unexpectedly without an exit record; both keep the scheduling reservation. Check the processes and partial results in the job record, and only after confirming the original task and its child processes stopped, clear this job's reservation with `dsb unlock <ID> --confirmed-stopped` and then create a new task. Never delete other jobs' reservations or assume a process exited because of a timeout.

While a job is still running, check its current progress first, then follow "Two-way messages and requests" in SKILL.md: add context with `dsb send`, answer questions with `dsb answer`, and read updates with `dsb events`. The host agent can only forward authorization it already has; when unsure, ask the user. After the job ends, no more messages can be sent; `dsb retry` creates a new session carrying the original brief and the fix feedback. On `input_rejected`, correct the specific cause; a queued receipt is not success.

## Resuming from partial results

Confirm the old job ended, compare the existing changes with the pre-dispatch baseline, and keep the verified results. The new brief should restate the necessary original goal, limits, and acceptance criteria, and add:

```text
[Resume] The previous job has ended. Reason: <actual exit/cancel/failure reason>.
Confirmed done: <results and evidence>. Still to do: <failed or unfinished parts>.
Related changes/logs: <paths>. Existing user changes among them: <what must be kept>.
Check the current state first, then finish the remaining work; do not start over or repeat external actions that already succeeded.
```

When an operation on an external application timed out and its outcome is unclear, query its current state read-only first, then decide whether to retry. When the outcome cannot be confirmed, report the uncertainty instead of guessing by repeating the operation.

## dsb is not on PATH

First check whether PATH just has not been refreshed. Any host can call the same bridge with `node "<dpsk-bridge repo>/bin/dsb.mjs" ...`. Make sure dependencies are installed and use the current `run` / `send` / `answer` / `events`. If you cannot control the process lifecycle, restore the host's ability to run commands first; do not drop the handle or wait forever instead.

## Viewer and updates

`dsv` reads v4 plain or zstd session logs; when no sessions are found, check `DSH_HOME` and `DSH_SESSIONS_ROOT`. With concurrent jobs, open the session by the ID in the job record instead of treating another session's `latest` as this job's report. An incomplete tail may just still be being written; the viewer shows everything before it, which does not mean the job ended.

`dsv update --check` checks GitHub Releases right away; the TUI caches release results for 6 hours. `dsv update`, or `u` in the TUI, installs a release. `dsv update --auto on|off` controls automatic updates, which are off by default. An update waits for bridge jobs to finish and then runs exclusively, queueing for at most 60 seconds and trying again later when busy; the TUI delays quitting while an update runs. With local changes or diverged history it does not overwrite anything; save the changes first and let the host check the diff. A failed network or release check does not mean there is no new version; never clean the workspace to force an update.

After an update, reopen `dsv` and refresh the installed skills in the host so it does not keep using old instructions. The automatic skill sync script currently requires Windows; on other platforms, copy the contents of `skill/` to the host's skills directory by hand.
