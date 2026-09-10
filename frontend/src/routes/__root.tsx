import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
  useLocation
} from "@tanstack/react-router";
import appCss from "../app/globals.css?url";
import appFontCss from "../app/font.css?url";
import tiptapCss from "../styles/tiptap.scss?url";
import { NextIntlClientProvider } from "@/i18n/compat/client";
import { useEffect } from "react";
import zhMessages from "@/i18n/locales/zh.json";
import enMessages from "@/i18n/locales/en.json";
import { Providers } from "@/app/providers";
import { Toaster } from "@/components/ui/sonner";
import { getPreferredLocale } from "@/i18n/runtime";
import { ReactGrab } from "@/components/dev/ReactGrab";
import { SITE_NAME } from "@/lib/seo/site";

// 首屏不再预载 Alibaba PuHuiTi 的两个 TTF（8.1MB + 7.9MB）。
// 该字体仅用于简历编辑器与 PDF 导出（src/utils/fonts.ts、components/Document.tsx），
// 落地页字体栈为 Inter / Noto Sans SC / system-ui，预载它等于让每个访客白下载 16MB，
// 直接拖垮 LCP。编辑器侧保持按需加载即可。
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1"
      },
      { title: SITE_NAME },
      { name: "theme-color", content: "#ffffff", media: "(prefers-color-scheme: light)" },
      { name: "theme-color", content: "#0b0b0f", media: "(prefers-color-scheme: dark)" }
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss
      },
      {
        rel: "stylesheet",
        href: appFontCss
      },
      {
        rel: "stylesheet",
        href: tiptapCss
      },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/icon.png" }
    ]
  }),
  component: RootComponent,
  notFoundComponent: RootNotFound
});

function RootComponent() {
  const pathname = useLocation({
    select: (location) => location.pathname
  });
  const locale = getPreferredLocale(pathname);
  const messages = locale === "en" ? enMessages : zhMessages;

  useEffect(() => {
    document.cookie = `NEXT_LOCALE=${locale}; path=/; max-age=31536000`;
  }, [locale]);

  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <HeadContent />
        <link rel="icon" href="/favicon.ico?v=2" />
        <link rel="icon" href="/icon.png" />
      </head>
      <body>
        <NextIntlClientProvider
          locale={locale}
          messages={messages}
          timeZone="Asia/Shanghai"
        >
          <Providers>
            <ReactGrab />
            <Outlet />
            <Toaster position="top-center" richColors />
          </Providers>
        </NextIntlClientProvider>
        <Scripts />
      </body>
    </html>
  );
}

function RootNotFound() {
  const pathname = useLocation({
    select: (location) => location.pathname
  });
  const locale = getPreferredLocale(pathname);
  const isEnglish = locale === "en";

  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-6">
      <div className="text-center space-y-2">
        <p className="text-3xl font-serif text-foreground/80">404</p>
        <p className="text-muted-foreground">
          {isEnglish ? "Page not found" : "页面不存在"}
        </p>
      </div>
      <Link
        to="/$locale"
        params={{ locale }}
        className="text-sm text-primary hover:underline"
      >
        {isEnglish ? "Back to home" : "返回首页"}
      </Link>
    </main>
  );
}
