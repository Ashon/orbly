import { Pause, Play } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { PaceSpinner } from './pace-spinner'

const SIZES = [16, 20, 24, 28, 48, 96, 192]
const SPEEDS = [0.1, 0.25, 0.5, 1]

/**
 * Development builds only: things to look at in motion, such as Pace's
 * spinner, with slow motion and a frame rate readout.
 */
export function DebugPage() {
  return (
    <ScrollArea className="h-full">
      <div className="max-w-4xl space-y-8 px-8 py-7">
        <header>
          <h1 className="text-lg font-semibold tracking-tight">Debug</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Only in development builds. Nothing here changes Pace or its
            settings.
          </p>
        </header>
        <SpinnerBench />
      </div>
    </ScrollArea>
  )
}

/**
 * Every spinner on the bench shares one clock: play, pause and speed apply to
 * all of their animations at once, so they stay in step.
 */
function SpinnerBench() {
  const bench = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(1)
  const { fps, longest, loop } = useFrameStats(bench)
  const [length, setLength] = useState(0)
  const [at, setAt] = useState(0)
  const animations = () => bench.current?.getAnimations({ subtree: true }) ?? []

  useEffect(() => {
    for (const animation of animations()) {
      animation.playbackRate = speed
      if (playing) animation.play()
      else animation.pause()
    }
  }, [playing, speed])

  useEffect(() => {
    const timing = animations()[0]?.effect?.getComputedTiming()
    setLength(Number(timing?.duration) || 0)
  }, [])

  // Scrubbing pauses every spinner at the same moment of the loop.
  const seek = (ms: number) => {
    setAt(ms)
    setPlaying(false)
    for (const animation of animations()) {
      animation.pause()
      animation.currentTime = ms
    }
  }

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="mr-auto text-sm font-semibold">Spinner</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {loop}
        </span>
        <span
          className={cn(
            'text-xs tabular-nums',
            fps < 55 ? 'text-status-interrupted' : 'text-muted-foreground'
          )}
          title="Frames drawn in the last second, and the longest gap between two"
        >
          {fps} fps · longest frame {longest} ms
        </span>
        <div role="radiogroup" className="flex rounded-lg bg-muted p-0.5">
          {SPEEDS.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={speed === value}
              onClick={() => setSpeed(value)}
              className={cn(
                'h-6 rounded-md px-2.5 text-xs font-medium tabular-nums transition-colors',
                speed === value
                  ? 'bg-card text-foreground shadow-xs dark:bg-selected'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {value}×
            </button>
          ))}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setPlaying(!playing)}
        >
          {playing ? <Pause /> : <Play />}
          {playing ? 'Pause' : 'Play'}
        </Button>
      </div>

      {length > 0 && (
        <label className="flex items-center gap-3 text-xs text-muted-foreground">
          Jump to
          <input
            type="range"
            min={0}
            max={Math.round(length)}
            step={10}
            value={at}
            onChange={(e) => seek(Number(e.target.value))}
            className="flex-1 accent-primary"
          />
          <span className="w-16 text-right tabular-nums">{at} ms</span>
        </label>
      )}

      <div ref={bench} className="space-y-6">
        <div className="flex flex-wrap items-end gap-x-8 gap-y-4 border-y border-border py-6">
          {SIZES.map((size) => (
            <figure
              key={size}
              className="flex flex-col items-center gap-2 text-[11px] text-muted-foreground"
            >
              <div style={{ width: size, height: size }}>
                <PaceSpinner className="size-full" />
              </div>
              <figcaption className="tabular-nums">{size}px</figcaption>
            </figure>
          ))}
        </div>

        {/* Where the app shows it: a run's timeline while Pace works */}
        <div className="flex flex-wrap gap-3">
          {(['bg-card', 'bg-card-accent', 'bg-well'] as const).map((bg) => (
            <div
              key={bg}
              className={cn(
                'flex items-center gap-3 rounded-xl border border-border px-4 py-3 text-xs font-medium text-status-running',
                bg
              )}
            >
              <PaceSpinner />
              Working
              <span className="font-normal text-muted-foreground">
                on {bg.replace('bg-', '')}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

/**
 * The frame rate over the last second, its longest frame, and where the first
 * spinner is in its loop.
 */
function useFrameStats(bench: React.RefObject<HTMLDivElement | null>) {
  const [stats, setStats] = useState({ fps: 0, longest: 0, loop: '' })
  useEffect(() => {
    let frame = 0
    let last = performance.now()
    let windowStart = last
    let frames = 0
    let longest = 0
    const tick = (now: number) => {
      frames++
      longest = Math.max(longest, now - last)
      last = now
      if (now - windowStart >= 1000) {
        const animation = bench.current?.getAnimations({ subtree: true })[0]
        const timing = animation?.effect?.getComputedTiming()
        const at = timing?.localTime
        const length = Number(timing?.duration)
        setStats({
          fps: Math.round((frames * 1000) / (now - windowStart)),
          longest: Math.round(longest),
          loop:
            typeof at === 'number' && length
              ? `${Math.round(at % length)} / ${Math.round(length)} ms`
              : '',
        })
        windowStart = now
        frames = 0
        longest = 0
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [bench])
  return stats
}
