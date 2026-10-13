import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

const jbMono = JetBrains_Mono({
  variable: "--font-jbmono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Venture Studio OS",
  description:
    "A shared operating system for ventures, groups, channels, and focused execution.",
  // Installed on an iPhone home screen it opens as its own app, which is what lets iOS show its notifications.
  appleWebApp: { capable: true, title: "Venture Studio", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7faf8" },
    { media: "(prefers-color-scheme: dark)", color: "#0b120e" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${jakarta.variable} ${jbMono.variable} h-full antialiased`}
    >
      <head><script dangerouslySetInnerHTML={{ __html: "var c=document.cookie.match(/(?:^|; )venture_studio_theme=(dark|light)/);document.documentElement.dataset.theme=c?.[1]||'light'" }} /></head>
      <body className="min-h-full bg-canvas font-sans text-neutral-900">
        {children}
      </body>
    </html>
  );
}
