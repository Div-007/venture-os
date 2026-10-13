import type { Metadata } from "next";
import { Suspense } from "react";
import { SalesFallback } from "@/components/sales/draft-shared";
import { InboxScreen } from "@/screens/sales/inbox";

export const metadata: Metadata = { title: "Inbox — Sales — Venture Studio OS" };

export default function Page() { return <Suspense fallback={<SalesFallback />}><InboxScreen /></Suspense>; }
