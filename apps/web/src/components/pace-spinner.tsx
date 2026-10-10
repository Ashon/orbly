import { useId } from 'react'
import { cn } from '@/lib/utils'
import './pace-spinner.css'

/** The ring, radius 164 around the center, drawn from the pupil's spot. */
const RING = {
  d: 'M372 140A164 164 0 1 0 140 372A164 164 0 1 0 372 140',
  // 2 pi 164: the dash lengths in pace-spinner.css are measured in it
  pathLength: 1030.44,
  fill: 'none',
  stroke: '#fff',
  strokeWidth: 84,
  strokeLinecap: 'round',
} as const

/**
 * Pace's mark at work: the dot looks around like a camera finding focus, and
 * now and then opens into an arc like a lens (keyframes in pace-spinner.css,
 * made by scripts/spinner-keyframes.py). Only the mask moves; the gradient
 * stays put.
 * Meant for 24 pixels and up: smaller, the dot and the gap blur together.
 */
export function PaceSpinner({
  className,
  label,
}: {
  className?: string
  /** Read out instead of the text beside it; without one it is decoration */
  label?: string
}) {
  // Each spinner needs its own gradient and mask ids.
  const id = useId().replace(/[^\w-]/g, '')
  return (
    <svg
      viewBox="0 0 512 512"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn('pace-spinner size-7 shrink-0', className)}
    >
      <defs>
        <linearGradient
          id={`${id}-gradient`}
          gradientUnits="userSpaceOnUse"
          x1="54"
          y1="314"
          x2="458"
          y2="198"
        >
          <stop offset="0" stopColor="#01ab78" />
          <stop offset="0.46" stopColor="#1fc289" />
          <stop offset="1" stopColor="#48c89c" />
        </linearGradient>
        <mask
          id={`${id}-mask`}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="512"
          height="512"
        >
          {/* Both are dashes on one circle that starts at the pupil: the
              track's dash leaves the opening, and the pupil's dash is the
              dot, or an arc while it focuses. (dash lengths: the CSS) */}
          <g className="pace-spinner-eye">
            <path className="pace-spinner-track" {...RING} />
            <path className="pace-spinner-pupil" {...RING} />
          </g>
        </mask>
      </defs>
      <rect
        width="512"
        height="512"
        fill={`url(#${id}-gradient)`}
        mask={`url(#${id}-mask)`}
      />
    </svg>
  )
}
