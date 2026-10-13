import type { Metadata } from "next";
import { OverviewScreen } from "@/screens/sales/overview";

export const metadata: Metadata = { title: "Sales — Venture Studio OS" };

export default function Page() { return <OverviewScreen />; }
