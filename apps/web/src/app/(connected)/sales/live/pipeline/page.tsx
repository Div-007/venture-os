import type { Metadata } from "next";
import { PipelineScreen } from "@/screens/sales/pipeline";

export const metadata: Metadata = { title: "Pipeline — Venture Studio OS" };

export default function Page() { return <PipelineScreen />; }
