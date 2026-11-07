/**
 * Process state of a bridge job, shared by dsb (status/wait) and dsv. Kept
 * free of the SDK and scheduler so the viewer can use it cheaply.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const bridgeHome = () =>
  path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'bridge');

export const QUESTION_LIMIT = 3;
export const REWORK_LIMIT = 1;
export const DEFAULT_CONTEXT_LIMIT = 200000;

/** States written by the supervisor once a job has really ended. */
export const TERMINAL_STATES = new Set([
  'completed',
  'failed',
  'timed_out',
  'cancelled',
  'launch_failed',
]);

export function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== 'ESRCH';
  }
}

/** The supervisor refreshes its heartbeat file this often while it runs. */
export const HEARTBEAT_INTERVAL_MS = 5000;

/** A heartbeat older than this no longer proves the recorded PID is the owner. */
export const HEARTBEAT_STALE_MS = 60000;

/**
 * Mark a heartbeat file fresh. The mtime is the signal, so touching it costs
 * no write; a missing file is recreated. Never throws while a job is running.
 */
export function touchHeartbeat(file, now = Date.now()) {
  if (!file) return false;
  try {
    fs.utimesSync(file, new Date(now), new Date(now));
    return true;
  } catch {}
  try {
    fs.writeFileSync(file, `${now}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Freshness of a recorded heartbeat. `null` means the record predates
 * heartbeats, so callers keep the PID-only check for it. A recorded heartbeat
 * that is missing or unreadable is stale: the supervisor claimed one and
 * stopped refreshing it.
 */
export function heartbeatFresh(file, now = Date.now(), staleMs = HEARTBEAT_STALE_MS) {
  if (!file) return null;
  try {
    return now - fs.statSync(file).mtimeMs <= staleMs;
  } catch {
    return false;
  }
}

/**
 * True when the recorded supervisor PID exists and its heartbeat is fresh.
 * Records without a heartbeat file keep the old PID-only behavior, because a
 * reused PID is indistinguishable for them.
 */
export function supervisorLive(job, now = Date.now(), staleMs = HEARTBEAT_STALE_MS) {
  if (!processExists(job?.supervisorPid)) return false;
  const fresh = heartbeatFresh(job?.heartbeatFile, now, staleMs);
  return fresh === null ? true : fresh;
}

/**
 * The recorded state, or `unknown` when the record still says the job is live
 * but its supervisor is gone or its heartbeat is stale (the launcher died
 * without an exit record, or its PID was reused by another process).
 */
export function liveProcessState(job, now = Date.now()) {
  if (TERMINAL_STATES.has(job.processState) || job.processState === 'cleanup_failed')
    return job.processState;
  return supervisorLive(job, now) ? job.processState : 'unknown';
}

/**
 * Bridge job record for a dsh session, or null when the session was not
 * started by dsb. Bridge jobs share their ID with the root dsh session.
 */
function jobForSession(sessionId, home = bridgeHome()) {
  if (!/^[a-f0-9-]{36}$/.test(String(sessionId))) return null;
  try {
    const job = JSON.parse(fs.readFileSync(path.join(home, 'jobs', sessionId, 'job.json'), 'utf8'));
    return job?.version === 2 ? job : null;
  } catch {
    return null;
  }
}

/**
 * The host session that started a bridge job, for display. `null` when dsb did
 * not start the session, or when the record predates ownership.
 */
export function sessionOwner(sessionId, home = bridgeHome()) {
  return jobForSession(sessionId, home)?.owner ?? null;
}

/**
 * True when a session's log still has an open turn but its bridge job is no
 * longer running: the supervisor died, or the job ended without closing the
 * turn (cancelled, failed, timed out). Sessions not started by dsb return false.
 */
export function sessionInterrupted(sessionId, home = bridgeHome()) {
  const job = jobForSession(sessionId, home);
  if (!job) return false;
  return !LIVE_STATES.has(liveProcessState(job));
}

/** States of a job whose supervisor is still working on it. */
const LIVE_STATES = new Set(['queued', 'starting', 'running', 'finishing']);
