import type * as React from 'react'
import { cn } from '@/lib/utils'

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      className={cn(
        'flex h-8 w-full min-w-0 rounded-md border border-input bg-background px-2.5 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:opacity-50 dark:bg-input/30',
        className
      )}
      {...props}
    />
  )
}

export { Input }
