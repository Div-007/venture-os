import type { Metadata } from "next";
import { Suspense } from "react";
import { SalesFallback } from "@/components/sales/draft-shared";
import { PlaysScreen } from "@/screens/sales/plays";

export const metadata: Metadata = { title: "Plays — Sales — Venture Studio OS" };

export default function Page() { return <Suspense fallback={<SalesFallback />}><PlaysScreen /></Suspense>; }
