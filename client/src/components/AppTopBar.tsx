import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function AppTopBar({
  left,
  right,
  maxWidthClassName = "max-w-6xl",
}: {
  left: ReactNode;
  right?: ReactNode;
  maxWidthClassName?: string;
}) {
  return (
    <header className="stripe-nav sticky top-0 z-50">
      <div className={cn("stripe-shell mx-auto px-4 sm:px-6", maxWidthClassName)}>
        <div className="stripe-topbar-frame">
          <div className="flex min-w-0 items-center gap-3">{left}</div>
          {right ? <div className="flex shrink-0 items-center gap-2 sm:gap-3">{right}</div> : null}
        </div>
      </div>
    </header>
  );
}
