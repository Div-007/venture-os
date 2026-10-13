import { HugeiconsIcon } from "@hugeicons/react";
import { FlashIcon, ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { Anim } from "@/components/ui/anim";

export function LogoutScreen() {
  return (
    <div className="grid h-full place-items-center p-6">
      <Anim>
        <div className="w-full max-w-sm rounded-2xl bg-white p-8 text-center">
          <span className="mx-auto grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-primary-500 to-primary-700">
            <HugeiconsIcon icon={FlashIcon} size={20} strokeWidth={2.25} className="text-white" />
          </span>
          <h1 className="mt-4 text-[18px] font-bold tracking-tight text-neutral-900">
            Signed out
          </h1>
          <p className="mt-1.5 text-[12.5px] font-medium text-neutral-500">
            You&apos;ve been securely signed out of AIBOS. Data synced at 10:42 am.
          </p>
          <a
            href="/dashboard"
            className="mt-5 flex items-center justify-center gap-1.5 rounded-full bg-primary-700 py-2.5 text-[12.5px] font-bold text-white transition-[background-color,transform] duration-150 hover:bg-primary-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.98]"
          >
            Sign back in
            <HugeiconsIcon icon={ArrowUpRight01Icon} size={14} strokeWidth={2} />
          </a>
        </div>
      </Anim>
    </div>
  );
}
