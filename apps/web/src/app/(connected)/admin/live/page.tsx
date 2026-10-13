import type { Metadata } from "next";
import { LiveAdminScreen } from "@/screens/live-admin";

export const metadata: Metadata = { title: "People & access — Venture Studio OS" };

export default function Page() { return <LiveAdminScreen />; }
