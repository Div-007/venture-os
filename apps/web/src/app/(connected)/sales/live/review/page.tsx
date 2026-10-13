import type { Metadata } from "next";
import { Suspense } from "react";
import { SalesFallback } from "@/components/sales/draft-shared";
import { ReviewScreen } from "@/screens/sales/review";

export const metadata: Metadata = { title: "Review — Sales — Venture Studio OS" };

export default function Page() { return <Suspense fallback={<SalesFallback />}><ReviewScreen /></Suspense>; }
