import type { Metadata } from "next";
import { Suspense } from "react";
import { SalesFallback } from "@/components/sales/draft-shared";
import { DoNotContactScreen } from "@/screens/sales/do-not-contact";

export const metadata: Metadata = { title: "Do not contact — Sales — Venture Studio OS" };

export default function Page() { return <Suspense fallback={<SalesFallback />}><DoNotContactScreen /></Suspense>; }
