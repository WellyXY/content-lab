import type { Metadata } from "next";
import { AppShell } from "@/components/content-lab/app-shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "Content Lab · TikTok Signal Desk",
  description: "Track TikTok post velocity, content signals, and viral alerts from one live desk.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-Hant">
      <body className="antialiased"><AppShell>{children}</AppShell></body>
    </html>
  );
}
