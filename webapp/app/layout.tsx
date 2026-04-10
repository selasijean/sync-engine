import type { Metadata } from "next";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Sync Engine Demo",
  description: "Real-time sync engine demo with Go backend and SSE",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: 0, background: "#fafafa" }}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
