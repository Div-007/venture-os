import type { Metadata } from "next";
import { LiveConnectScreen } from "@/screens/live-connect";

export const metadata: Metadata = { title: "Connect Claude — Venture Studio OS" };

export default function Page() { return <LiveConnectScreen />; }
