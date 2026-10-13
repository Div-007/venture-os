import type { Metadata } from "next";
import { Suspense } from "react";
import { SalesFallback } from "@/components/sales/draft-shared";
import { SetupScreen } from "@/screens/sales/setup";

export const metadata: Metadata = { title: "Set up sales — Sales — Venture Studio OS" };

export default function Page() { return <Suspense fallback={<SalesFallback />}><SetupScreen /></Suspense>; }
