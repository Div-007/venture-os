import { Instrument_Serif } from "next/font/google";
import { Layers3 } from "@/components/ui/icons";
import { AuthBg } from "./auth-bg";

const serif = Instrument_Serif({ weight: "400", subsets: ["latin"] });

// Shared form styles for every auth screen (sign-in, setup, invitations).
export const authLabel = "mb-1.5 block text-[0.8125rem] font-medium leading-4 text-[#3f3f46]";
export const authField = "h-[50px] w-full rounded-xl border border-transparent bg-[#f4f4f6] px-4 text-[0.875rem] leading-[1.125rem] text-[#18181b] outline-none transition-[border-color,background-color,box-shadow] duration-150 placeholder:text-[#a1a1aa] focus:border-[#27272a] focus:bg-white focus:ring-2 focus:ring-[#27272a]/10";
export const authPrimary = "flex h-[50px] w-full items-center justify-center gap-2 rounded-xl bg-[#18181b] text-[0.875rem] font-semibold leading-[1.125rem] text-white transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.995] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#27272a] focus-visible:ring-offset-2";
export const authSecondary = "flex h-[50px] w-full items-center justify-center gap-2.5 rounded-xl border border-[#e4e4e7] bg-white text-[0.875rem] font-medium leading-[1.125rem] text-[#18181b] transition-[background-color,transform] duration-150 hover:bg-[#fafafa] active:scale-[0.995] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#27272a] focus-visible:ring-offset-2";
export const authLink = "font-semibold text-[#18181b] underline underline-offset-2 hover:text-[#3f3f46]";

/**
 * The auth screen frame: an animated silk background, a framed showcase panel on wide screens, and a white form panel.
 * `headline`/`blurb` let each flow (sign-in, setup, invitation) speak to what the person is doing.
 */
export function AuthShell({ children, headline = "Every venture, one operating rhythm.", blurb = "Goals, work, evidence, and decisions for each venture, in one shared workspace." }: { children: React.ReactNode; headline?: string; blurb?: string }) {
  return <div className="relative flex min-h-dvh items-stretch justify-center p-3 sm:p-5">
    <AuthBg />
    <div className="vso-auth-frame flex w-full max-w-[1400px] [filter:drop-shadow(0_20px_60px_rgba(0,0,0,0.4))]">
      {/* White ring with a transparent middle, so the animated background shows through. */}
      <div className="hidden w-[46%] shrink-0 md:block">
        <div className="relative h-full rounded-l-[28px] border-[12px] border-white">
          <div className="absolute inset-0 overflow-hidden rounded-l-[16px]">
            <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-black/10 to-black/20" />
            <div className="absolute left-8 top-8 flex items-center gap-4">
              <span className="text-[0.6875rem] font-medium tracking-[0.22em] text-white/85">VENTURE STUDIO OS</span>
              <span className="h-px w-16 bg-white/40" />
            </div>
            <div className="absolute bottom-10 left-8 right-8">
              <p className={`${serif.className} text-[3.4rem] leading-[1.05] text-white`}>{headline}</p>
              <p className="mt-4 max-w-[380px] text-[0.8125rem] leading-[1.55] text-white/75">{blurb}</p>
            </div>
          </div>
        </div>
      </div>
      <main className="relative flex min-h-[calc(100dvh-40px)] flex-1 flex-col items-center justify-center rounded-[28px] bg-white px-6 py-10 text-[#18181b] sm:px-12 md:min-h-0 md:rounded-[0_28px_28px_0]">
        {children}
      </main>
    </div>
  </div>;
}

/** Brand row and the serif title block that opens every auth form. `swapKey` replays the fade when the content changes. */
export function AuthHeading({ title, subtitle, swapKey }: { title: string; subtitle: React.ReactNode; swapKey?: string }) {
  return <>
    <div className="flex items-center justify-center gap-2.5">
      <span className="grid h-[34px] w-[34px] place-items-center rounded-[10px] bg-primary-600 text-white"><Layers3 size={18} /></span>
      <span className="text-[1.0625rem] font-bold tracking-tight">VENTURE STUDIO</span>
    </div>
    <div key={swapKey ?? title} className="vso-auth-rise mt-7 text-center">
      <h1 className={`${serif.className} text-[2.75rem] leading-[1.1] text-[#18181b]`}>{title}</h1>
      <p className="mt-2 text-[0.8125rem] leading-[1.45] text-[#71717a]">{subtitle}</p>
    </div>
  </>;
}

/** Inline status for auth forms: errors (red), confirmations (green), and setup warnings (amber). */
export function AuthMessage({ tone, children }: { tone: "error" | "success" | "warning"; children: React.ReactNode }) {
  const styles = { error: "bg-[#fee2e2] text-[#991b1b]", success: "bg-[#dcfce7] text-[#166534]", warning: "bg-[#fef3c7] text-[#92400e]" }[tone];
  return <div role={tone === "success" ? "status" : "alert"} className={`vso-auth-rise rounded-lg px-3 py-2.5 text-[0.8125rem] leading-[1.35rem] ${styles}`}>{children}</div>;
}
