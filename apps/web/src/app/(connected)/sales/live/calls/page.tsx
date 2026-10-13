import type { Metadata } from "next";
import { Suspense } from "react";
import { SalesFallback } from "@/components/sales/draft-shared";
import { CallsScreen } from "@/screens/sales/calls";

export const metadata: Metadata = { title: "Calls — Sales — Venture Studio OS" };

export default function Page() { return <Suspense fallback={<SalesFallback />}><CallsScreen /></Suspense>; }
