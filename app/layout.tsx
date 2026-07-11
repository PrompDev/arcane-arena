import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1")
      ? "http"
      : "https");
  const socialImage = new URL("/og.png", `${protocol}://${host}`).toString();
  const description =
    "Fast original multiplayer spell duels built for the browser with WebGPU.";

  return {
    title: {
      default: "Arcane Arena",
      template: "%s · Arcane Arena",
    },
    description,
    applicationName: "Arcane Arena",
    category: "game",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      type: "website",
      title: "Arcane Arena — Multiplayer spell duels",
      description,
      images: [{ url: socialImage, width: 1672, height: 941 }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Arcane Arena — Multiplayer spell duels",
      description,
      images: [socialImage],
    },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "dark",
  themeColor: "#05070b",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
