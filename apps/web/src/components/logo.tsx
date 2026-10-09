import { cn } from '@/lib/utils'

export function PacenoteMark({ className }: { className?: string }) {
  return (
    <img
      src="/pacenote.svg"
      alt=""
      className={cn('size-6 select-none', className)}
      draggable={false}
    />
  )
}
