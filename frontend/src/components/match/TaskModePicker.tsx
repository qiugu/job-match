// 任务类型选择器：JD 简历匹配 / JD 话术匹配 / 两者都要。
//
// 三者是平级入口——话术不再依附于「先跑完匹配」的二级 tab。
// 仅话术模式不会触发简历优化链路，直接生成话术。
import { Check, Crosshair, Mail, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import SectionLabel from "@/components/match/SectionLabel";
import { useTranslations } from "@/i18n/compat/client";

export type TaskMode = "match" | "pitch" | "both";

const OPTIONS: Array<{
  value: TaskMode;
  icon: typeof Crosshair;
  titleKey: string;
  descKey: string;
  costKey: string;
}> = [
  {
    value: "pitch",
    icon: Mail,
    titleKey: "taskModePitch",
    descKey: "taskModePitchDesc",
    costKey: "taskModeCostPitch",
  },
  {
    value: "match",
    icon: Crosshair,
    titleKey: "taskModeMatch",
    descKey: "taskModeMatchDesc",
    costKey: "taskModeCostMatch",
  },
  {
    value: "both",
    icon: Layers,
    titleKey: "taskModeBoth",
    descKey: "taskModeBothDesc",
    costKey: "taskModeCostBoth",
  },
];

interface TaskModePickerProps {
  value: TaskMode;
  onChange: (v: TaskMode) => void;
  disabled?: boolean;
}

export default function TaskModePicker({
  value,
  onChange,
  disabled,
}: TaskModePickerProps) {
  const t = useTranslations("jobmatch");

  return (
    <div className="space-y-2">
      <SectionLabel no="01">{t("taskMode")}</SectionLabel>
      <div
        role="radiogroup"
        aria-label={t("taskMode")}
        className="grid gap-2"
      >
        {OPTIONS.map((opt) => {
          const active = value === opt.value;
          const Icon = opt.icon;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => onChange(opt.value)}
              className={cn(
                "group relative flex w-full items-start gap-3 rounded-lg border px-3.5 py-3 text-left transition-all",
                "disabled:cursor-not-allowed disabled:opacity-60",
                active
                  ? "border-primary bg-primary/[0.06]"
                  : "border-border bg-muted/30 hover:border-primary/40 hover:bg-muted/50"
              )}
            >
              {/* 选中态左侧竖条：hairline 风格，不用阴影 */}
              <span
                aria-hidden
                className={cn(
                  "absolute left-0 top-2.5 bottom-2.5 w-[2px] rounded-full transition-opacity",
                  active ? "bg-primary opacity-100" : "opacity-0"
                )}
              />
              <span
                className={cn(
                  "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-colors",
                  active
                    ? "border-primary/30 bg-primary/10 text-primary"
                    : "border-border bg-background text-muted-foreground"
                )}
              >
                <Icon className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      "text-sm font-medium",
                      active ? "text-foreground" : "text-card-foreground"
                    )}
                  >
                    {t(opt.titleKey)}
                  </span>
                  {active && (
                    <Check className="h-3.5 w-3.5 text-primary" aria-hidden />
                  )}
                </span>
                <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                  {t(opt.descKey)}
                </span>
                {/* 中文小标签走 .eb-zh：禁 mono / uppercase / 字距，避免拉散汉字 */}
                <span className="eb-zh mt-1.5 inline-flex items-center rounded-md border border-line-strong bg-paper px-2 py-0.5 text-ink-3">
                  {t(opt.costKey)}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
