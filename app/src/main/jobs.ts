// Startup jobs (architecture.md "Jobs"): crash recovery, notes retries, interrupted
// resume conversions, the daily backup and orphaned-file cleanup. Each job is
// restartable because its state lives in a status column. Resume parsing is on demand
// (revision 2 §11), so it isn't started here.
import { all, backup, get, run } from './db/client'
import { getSettings, now, patchSettings } from './db/repo'
import { convertResume, pendingNotes, runNotes } from './ai/content'
import { cleanupFiles } from './files'
import { log } from './log'
import { initRegistry } from './stt/registry'

const FOUR_HOURS = 4 * 60 * 60_000

// Conversions interrupted by the previous run, listed before any window can start a new
// one (an import in progress must not be picked up as "interrupted" and run twice).
let interruptedConversions: string[] = []

export function recoverOnStartup() {
  const t = now()
  interruptedConversions = all<{ id: string }>(`select id from resumes where source = 'pdf' and md_status in ('pending','converting')`).map((r) => r.id)
  for (const s of all<{ id: string; live_since: number | null }>(`select id, live_since from sessions where status = 'live'`)) {
    const last = Number(get<{ t: number | null }>('select max(spoken_at) as t from transcript_segments where session_id = ?', s.id)?.t ?? 0)
    const since = s.live_since === null ? null : Number(s.live_since)
    const add = since ? Math.min(Math.max(0, (last > since ? last : t) - since), FOUR_HOURS) : 0
    run(`update sessions set status = 'left', active_ms = active_ms + ?, live_since = null, updated_at = ? where id = ?`, add, t, s.id)
  }
  run(`update answers set status = 'cancelled', end_reason = 'session_end', updated_at = ? where status = 'streaming'`, t)
  run(`update session_notes set status = 'pending', updated_at = ? where status = 'generating'`, t)
  run(`update resumes set parse_status = 'pending', updated_at = ? where parse_status = 'parsing'`, t)
  run(`update review_messages set status = 'failed', content = case when content = '' then 'Interrupted when the app closed. Ask again.' else content end, updated_at = ? where status = 'streaming'`, t)
  initRegistry()
}

export function runStartupJobs() {
  for (const id of pendingNotes()) void runNotes(id)
  for (const id of interruptedConversions.splice(0)) void convertResume(id)
  try {
    const s = getSettings()
    if (!s.lastBackupAt || now() - s.lastBackupAt > 24 * 60 * 60_000) {
      backup()
      patchSettings({ lastBackupAt: now() })
    }
  } catch (e) {
    log('backup_failed', { errorName: (e as Error).name })
  }
  try {
    cleanupFiles()
  } catch (e) {
    log('file_cleanup_failed', { errorName: (e as Error).name })
  }
}
