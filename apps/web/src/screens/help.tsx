import { HugeiconsIcon } from "@hugeicons/react";
import {
  BookOpen01Icon,
  Video01Icon,
  HeadphonesIcon,
  WhatsappIcon,
  HelpCircleIcon,
  KeyboardIcon,
} from "@hugeicons/core-free-icons";
import { PageHeader } from "@/components/ui/page-header";
import { Anim } from "@/components/ui/anim";

const cards = [
  { icon: BookOpen01Icon, t: "User guide", d: "Step-by-step guides for every module — English & Hindi", cta: "Browse articles" },
  { icon: Video01Icon, t: "Video tutorials", d: "5-min walkthroughs: invoicing, stock, payroll", cta: "Watch" },
  { icon: KeyboardIcon, t: "Keyboard shortcuts", d: "Ctrl K search · Ctrl / AI dock · Enter = next row", cta: "View all" },
  { icon: WhatsappIcon, t: "WhatsApp support", d: "Chat with Buildory support — replies <30 min", cta: "Open chat" },
  { icon: HeadphonesIcon, t: "Call support", d: "Mon–Sat 9am–7pm IST · +91 98xxx xxxxx", cta: "Request callback" },
  { icon: HelpCircleIcon, t: "FAQs", d: "GST setup, Tally import, adding users and more", cta: "View FAQs" },
];

export function HelpScreen() {
  return (
    <div className="mx-auto max-w-[1200px] p-6">
      <PageHeader
        title="Help Desk"
        subtitle="Guides, tutorials and ways to reach the Buildory team"
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c, i) => (
          <Anim key={c.t} delay={80 + i * 50}>
            <button
              type="button"
              className="flex h-full w-full flex-col rounded-2xl bg-white p-5 text-left transition-[background-color,transform] duration-150 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.98]"
            >
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary-50 text-primary-600">
                <HugeiconsIcon icon={c.icon} size={19} strokeWidth={1.5} />
              </span>
              <p className="mt-3.5 text-[13.5px] font-bold text-neutral-900">{c.t}</p>
              <p className="mt-1 flex-1 text-[12px] font-medium leading-relaxed text-neutral-500">{c.d}</p>
              <p className="mt-3 text-[11.5px] font-bold text-primary-600">{c.cta} →</p>
            </button>
          </Anim>
        ))}
      </div>
    </div>
  );
}
