import { useRef, useState } from 'react'
import { LogOut, Square } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Modal } from '@renderer/components/ui/overlays'
import { errorText } from '@renderer/lib/format'

/** S26: leave for now (rejoinable) or end the call. */
export function EndDialog({ open, onOpenChange, onChoose }: { open: boolean; onOpenChange: (v: boolean) => void; onChoose: (mode: 'leave' | 'end') => Promise<void> }) {
  const [busy, setBusy] = useState<'leave' | 'end' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const leaveRef = useRef<HTMLButtonElement>(null)
  const run = async (mode: 'leave' | 'end') => {
    setBusy(mode)
    setError(null)
    try {
      await onChoose(mode)
    } catch (e) {
      setError(errorText(e))
      setBusy(null)
    }
  }
  return (
    <Modal open={open} onOpenChange={(v) => !busy && onOpenChange(v)} title="Leave or end this call?" initialFocus={leaveRef}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <LogOut size={20} strokeWidth={1.5} className="text-text-muted" aria-hidden />
          <h3 className="text-base font-semibold">Leave for now</h3>
          <p className="flex-1 text-xs text-text-muted">Go back to your list. The call stays open and you can rejoin it.</p>
          <Button ref={leaveRef} size="lg" variant="secondary" className="mt-2 w-full" loading={busy === 'leave'} busyLabel="Leaving…" disabled={busy === 'end'} onClick={() => void run('leave')}>
            Leave for now
          </Button>
        </div>
        <div className="flex flex-col gap-1.5">
          <Square size={20} strokeWidth={1.5} className="text-danger-text" aria-hidden />
          <h3 className="text-base font-semibold">End call</h3>
          <p className="flex-1 text-xs text-text-muted">Stop listening and save the transcript. Notes are written in the background.</p>
          <Button size="lg" variant="danger" className="mt-2 w-full" loading={busy === 'end'} busyLabel="Ending…" disabled={busy === 'leave'} onClick={() => void run('end')}>
            End call
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-xs text-danger-text">
          {error}
        </p>
      )}
    </Modal>
  )
}
