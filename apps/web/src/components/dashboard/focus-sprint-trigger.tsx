"use client";

export function FocusSprintTrigger({ children, className }: { children: React.ReactNode; className: string }) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent("venture:focus-sprint"))}
      className={className}
    >
      {children}
    </button>
  );
}
