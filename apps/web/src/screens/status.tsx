import { HugeiconsIcon } from "@hugeicons/react";
import {
  CheckmarkCircle01Icon,
  ServerStack01Icon,
  Database01Icon,
  WhatsappIcon,
  BankIcon,
  Mail01Icon,
  AiMagicIcon,
} from "@hugeicons/core-free-icons";
import { PageHeader } from "@/components/ui/page-header";
import { StatusChip } from "@/components/ui/status-chip";
import { Anim } from "@/components/ui/anim";

const services = [
  { icon: ServerStack01Icon, name: "Web app & API", uptime: "99.98%", status: "Operational" },
  { icon: Database01Icon, name: "Database & backups", uptime: "100%", status: "Operational" },
  { icon: AiMagicIcon, name: "AI engine", uptime: "99.9%", status: "Operational" },
  { icon: WhatsappIcon, name: "WhatsApp delivery", uptime: "99.7%", status: "Operational" },
  { icon: BankIcon, name: "Bank feeds", uptime: "99.4%", status: "Operational" },
  { icon: Mail01Icon, name: "Email / SMTP", uptime: "99.99%", status: "Operational" },
];

export function StatusScreen() {
  return (
    <div className="mx-auto max-w-[900px] p-6">
      <PageHeader
        title="System Status"
        subtitle="All systems operational — last checked just now"
      />
      <Anim delay={80}>
        <div className="mb-5 flex items-center gap-3 rounded-2xl bg-success-surface px-5 py-4">
          <span className="grid h-9 w-9 place-items-center rounded-full bg-success text-white">
            <HugeiconsIcon icon={CheckmarkCircle01Icon} size={18} strokeWidth={2} />
          </span>
          <div>
            <p className="text-[13.5px] font-bold text-success-text">All systems operational</p>
            <p className="text-[11.5px] font-medium text-success-text/70">30-day uptime 99.9% · next maintenance Sun 2–4am</p>
          </div>
        </div>
      </Anim>
      <div className="rounded-2xl bg-white">
        {services.map((s, i) => (
          <Anim key={s.name} delay={120 + i * 40}>
            <div className="flex items-center gap-3.5 px-5 py-3.5">
              <HugeiconsIcon icon={s.icon} size={18} strokeWidth={1.5} className="text-neutral-300" />
              <p className="flex-1 text-[13px] font-semibold text-neutral-800">{s.name}</p>
              <p className="text-[11px] font-medium text-neutral-400 tnum">{s.uptime} / 30d</p>
              <StatusChip label={s.status} tone="success" />
            </div>
          </Anim>
        ))}
      </div>
    </div>
  );
}
