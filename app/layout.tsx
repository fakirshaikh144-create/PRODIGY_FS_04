import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Prodigy Chat",
  description: "Minimal real-time chat app with rooms and direct messages.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
