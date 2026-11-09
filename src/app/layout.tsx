import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Northstar Sales Agent",
  description:
    "Ask for a sales dashboard and open it beside the chat, with live data from the Neon sales database: net sales, targets, returns, customers, and promotions.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
