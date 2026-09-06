import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Loci — что память делает с ответом",
  description: "25 кадров OSV-5M: один и тот же снимок без памяти, с уроками и с подменёнными уроками.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
