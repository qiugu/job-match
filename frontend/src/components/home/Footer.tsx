import { useTranslations } from "@/i18n/compat/client";
import Logo from "@/components/shared/Logo";
import { IcpFilingLink } from "@/components/shared/IcpFiling";
import { PublicSecurityFilingLink } from "@/components/shared/PublicSecurityFiling";

export default function Footer() {
  const t = useTranslations("home");

  return (
    <footer className="py-16 md:py-20 border-t-2 border-ink bg-paper-2">
      <div className="container mx-auto px-6 max-w-6xl">
        {/*
          单行三列：左 Logo+字标 / 中 备案号 / 右 版权 —— items-center 保证
          三者在同一基线。移动端退化为纵向堆叠并居中。
        */}
        <div className="flex flex-col items-center gap-6 md:grid md:grid-cols-3 md:items-center md:gap-4">
          <div className="flex items-center gap-3 md:justify-self-start">
            <Logo size={32} />
            <span className="font-display font-extrabold text-lg text-ink">JDMatch</span>
          </div>

          <div className="md:justify-self-center">
            <div className="flex flex-col items-center gap-1.5">
              <IcpFilingLink />
              <PublicSecurityFilingLink />
            </div>
          </div>

          <div className="text-sm text-ink-3 md:justify-self-end">
            <p>{t("footer.copyright")}</p>
          </div>
        </div>
      </div>
    </footer>
  );
}