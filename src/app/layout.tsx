import type { Metadata } from "next";
import localFont from 'next/font/local';
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { ExitApplication } from '@/components/fate/exit-application';

const geistSans = localFont({
  src: '../../node_modules/geist/dist/fonts/geist-sans/Geist-Variable.woff2',
  variable: "--font-geist-sans",
});

const geistMono = localFont({
  src: '../../node_modules/geist/dist/fonts/geist-mono/GeistMono-Variable.woff2',
  variable: "--font-geist-mono",
});

export const metadata: Metadata = {
  title: "Fate RPG Tool — Виртуальный стол",
  description: "Виртуальный стол для настольной ролевой игры Fate: броски кубиков, карты, персонажи, инициатива, журнал мастера и многое другое.",
  keywords: ["Fate", "RPG", "Fate Core", "Fate Accelerated", "настольная ролевая игра", "виртуальный стол", "VTT", " dice", "кубики"],
  authors: [{ name: "Fate RPG Tool" }],
  icons: {
    icon: "/logo.svg",
  },
  openGraph: {
    title: "Fate RPG Tool — Виртуальный стол",
    description: "Виртуальный стол для настольной ролевой игры Fate",
    siteName: "Fate RPG Tool",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Fate RPG Tool",
    description: "Виртуальный стол для настольной ролевой игры Fate",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <ExitApplication>{children}</ExitApplication>
        <Toaster />
        <SonnerToaster position="top-right" richColors closeButton />
      </body>
    </html>
  );
}
