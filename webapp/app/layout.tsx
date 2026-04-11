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
        {/*
          Hydration-failure recovery: when Chrome duplicates a loaded tab it copies
          the live DOM. React's initial render produces the loading fallback
          (smRef is null), causing a hydration mismatch that aborts the entire
          layout client-component tree — Providers never mounts.

          This script detects that failure and reloads once. On the reload Chrome
          makes a fresh navigation so the DOM matches the SSR output and hydration
          succeeds. sessionStorage prevents an infinite reload loop.
        */}
        <script dangerouslySetInnerHTML={{ __html: `
          window.addEventListener("load", function() {
            setTimeout(function() {
              if (!window.__providersMounted) {
                if (!sessionStorage.getItem("__hydrationReload")) {
                  sessionStorage.setItem("__hydrationReload", "1");
                  location.reload();
                }
              } else {
                sessionStorage.removeItem("__hydrationReload");
              }
            }, 500);
          });
        ` }} />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
