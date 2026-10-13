import type { Metadata } from "next";
import { Suspense } from "react";
import { SalesFallback } from "@/components/sales/draft-shared";
import { FindScreen } from "@/screens/sales/find";

export const metadata: Metadata = { title: "Find leads — Sales — Venture Studio OS" };

export default function Page() { return <Suspense fallback={<SalesFallback />}><FindScreen /></Suspense>; }
