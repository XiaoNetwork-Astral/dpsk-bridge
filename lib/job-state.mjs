/**
 * Process state of a bridge job, shared by dsb (status/wait) and dsv. Kept
 * free of the SDK and scheduler so the viewer can use it cheaply.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const bridgeHome = () => path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'bridge');

/** States written by the supervisor once a job has really ended. */
export const TERMINAL_STATES = new Set(['completed', 'failed', 'timed_out', 'cancelled', 'launch_failed']);

export function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}

/**
 * The recorded state, or `unknown` when the record still says the job is live
 * but its supervisor process is gone (the launcher died without an exit record).
 */
export function liveProcessState(job) {
  if (TERMINAL_STATES.has(job.processState) || job.processState === 'cleanup_failed') return job.processState;
  return processExists(job.supervisorPid) ? job.processState : 'unknown';
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
  } catch { return null; }
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
