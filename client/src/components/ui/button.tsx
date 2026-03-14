import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-semibold tracking-[-0.01em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 transition-all duration-200",
  {
    variants: {
      variant: {
        default:
          "border border-primary/70 bg-[linear-gradient(135deg,#635bff_0%,#7a73ff_100%)] text-primary-foreground shadow-[0_18px_40px_-24px_rgba(99,91,255,0.65)] hover:-translate-y-0.5 hover:shadow-[0_24px_56px_-28px_rgba(99,91,255,0.7)]",
        destructive:
          "border border-destructive/70 bg-destructive text-destructive-foreground shadow-[0_18px_36px_-24px_rgba(244,63,94,0.45)] hover:-translate-y-0.5",
        outline:
          "border border-white/80 bg-white/88 text-foreground shadow-[0_18px_40px_-32px_rgba(15,23,42,0.24)] hover:-translate-y-0.5 hover:border-primary/20 hover:text-primary",
        secondary: "border border-secondary-border bg-secondary/92 text-secondary-foreground hover:-translate-y-0.5 hover:border-primary/15",
        ghost: "border border-transparent text-foreground/78 hover:bg-white/70 hover:text-foreground",
      },
      // Heights are set as "min" heights, because sometimes Ai will place large amount of content
      // inside buttons. With a min-height they will look appropriate with small amounts of content,
      // but will expand to fit large amounts of content.
      size: {
        default: "min-h-10 px-5 py-2.5",
        sm: "min-h-8 px-3.5 text-xs",
        lg: "min-h-11 px-8 text-sm",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  },
)
Button.displayName = "Button"

export { Button, buttonVariants }
