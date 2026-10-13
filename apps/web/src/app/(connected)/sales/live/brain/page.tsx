import type { Metadata } from "next";
import { Suspense } from "react";
import { SalesFallback } from "@/components/sales/draft-shared";
import { OffersScreen } from "@/screens/sales/offers";

export const metadata: Metadata = { title: "Offers — Sales — Venture Studio OS" };

export default function Page() { return <Suspense fallback={<SalesFallback />}><OffersScreen /></Suspense>; }
