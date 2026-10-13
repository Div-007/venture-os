import type { Metadata } from "next";
import { LeadsScreen } from "@/screens/sales/leads";

export const metadata: Metadata = { title: "Leads — Venture Studio OS" };

export default function Page() { return <LeadsScreen />; }
