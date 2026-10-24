import { ArrowRight, Sparkles } from "lucide-react";
import { useTranslations } from "@/i18n/compat/client";
import { cn } from "@/lib/utils";

interface NewsAlertProps {
  className?: string;
}

export default function NewsAlert({ className }: NewsAlertProps) {
  const t = useTranslations("home");

  return (
    <div
      className={cn(
        "relative inline-flex items-center gap-3 px-5 py-2.5 text-sm font-semibold rounded-full",
        "bg-butter shadow-chip",
        "border-2 border-ink",
        "transition-all duration-300 cursor-pointer group text-ink",
        className
      )}
    >
      <span className="whitespace-nowrap">
        {t("news.content")}
      </span>
      {/* <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-colors flex-shrink-0" /> */}
    </div>
  );
}
