
import { useState } from "react";
import { usePathname } from "@/lib/navigation";
import { useTranslations } from "@/i18n/compat/client";
import { Menu, Moon, Sun, X } from "lucide-react";

import Logo from "@/components/shared/Logo";
import ThemeToggle from "@/components/shared/ThemeToggle";
import LanguageSwitch from "@/components/shared/LanguageSwitch";
import ScrollHeader from "./client/ScrollHeader";
import MobileMenu from "./client/MobileMenu";
import GoDashboard from "./GoDashboard";

export default function LandingHeader() {
  const t = useTranslations("home");
  const pathname = usePathname();
  const locale = pathname.split("/")[1];
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  return (
    <>
      <ScrollHeader>
        <div className="mx-auto max-w-[1200px] px-4">
          <div className="flex items-center justify-between h-20">
            <div
              className="flex items-center  cursor-pointer group"
              onClick={() => (window.location.href = `/${locale}/`)}
            >
              <Logo size={60} />
              <span className="font-display text-[24px] tracking-tight font-extrabold text-ink">
                {t("header.title")}
              </span>
            </div>

            <div className="hidden md:flex items-center gap-4">
              <LanguageSwitch />
              <ThemeToggle>
                <div className="w-9 h-9 relative cursor-pointer rounded-xl border-2 border-ink bg-ppcard hover:bg-paper-2 flex items-center justify-center transition-colors shadow-chip">
                  <Sun className="h-[1.1rem] w-[1.1rem] absolute inset-0 m-auto rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
                  <Moon className="h-[1.1rem] w-[1.1rem] absolute inset-0 m-auto rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
                </div>
              </ThemeToggle>

              <GoDashboard>
                <button
                  type="button"
                  className="pp-btn h-10 px-6"
                >
                  {t("header.startButton")}
                </button>
              </GoDashboard>
            </div>

            <button
              className="md:hidden p-2.5 rounded-xl border-2 border-ink bg-ppcard hover:bg-paper-2 transition-colors"
              onClick={() => setIsMenuOpen(!isMenuOpen)}
            >
              {isMenuOpen ? (
                <X className="w-6 h-6" />
              ) : (
                <Menu className="w-6 h-6" />
              )}
            </button>
          </div>
        </div>
      </ScrollHeader>

      <MobileMenu
        isOpen={isMenuOpen}
        onClose={() => setIsMenuOpen(false)}
        buttonText={t("header.startButton")}
      />
    </>
  );
}
