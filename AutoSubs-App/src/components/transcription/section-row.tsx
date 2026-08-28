import * as React from "react";
import { cn } from "@/lib/utils";

interface SectionHeaderProps {
  label: string;
  action?: React.ReactNode;
}

export function SectionHeader({ label, action }: SectionHeaderProps) {
  return (
    <div className="mb-3 flex items-center gap-2.5">
      <h3 className="text-base font-semibold leading-none text-foreground">
        {label}
      </h3>
      {action ? <div className="ml-auto min-w-0">{action}</div> : null}
    </div>
  );
}

interface CompactSettingsRowProps {
  label: string;
  children: React.ReactNode;
  className?: string;
}

export function CompactSettingsRow({
  label,
  children,
  className,
}: CompactSettingsRowProps) {
  return (
    <div
      className={cn(
        "grid grid-cols-[112px_minmax(0,1fr)] items-center gap-3 px-3 py-2.5",
        className,
      )}
    >
      <h3 className="min-w-0 truncate text-sm font-semibold leading-none text-foreground">
        {label}
      </h3>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
