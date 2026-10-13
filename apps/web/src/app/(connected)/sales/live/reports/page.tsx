import type { Metadata } from "next";
import { Suspense } from "react";
import { SalesFallback } from "@/components/sales/draft-shared";
import { ReportsScreen } from "@/screens/sales/reports";

export const metadata: Metadata = { title: "Reports — Sales — Venture Studio OS" };

export default function Page() { return <Suspense fallback={<SalesFallback />}><ReportsScreen /></Suspense>; }
