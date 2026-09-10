import React from "react";
import { useTranslations } from "@/i18n/compat/client";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import AnimatedFeature from "./client/AnimatedFeature";
import RegistrationCodeCTA from "./client/RegistrationCodeCTA";

interface FaqItem {
  question: string;
  answer: string;
  /** 答案尾部附加的自助入口，当前支持 registration-code（获取注册码弹框） */
  action?: string;
}

export default function FAQSection() {
  const t = useTranslations("home.faq");
  const faqItems = t.raw("items") as FaqItem[];

  return (
    <section className="py-24 md:py-40 bg-background relative overflow-hidden">
      <div className="container mx-auto px-6 max-w-3xl">
        <AnimatedFeature>
          <div className="text-center mb-16 md:mb-20">
            <h2 className="text-4xl md:text-5xl font-serif font-semibold tracking-tight text-foreground/90">
              {t("title")}
            </h2>
            <div className="w-16 h-1 bg-primary/20 mx-auto rounded-full mt-6" />
          </div>
        </AnimatedFeature>

        <AnimatedFeature delay={0.2}>
          <Accordion type="single" collapsible className="w-full space-y-4">
            {faqItems.map((item, index) => (
                <AccordionItem 
                  key={index} 
                  value={`item-${index}`}
                  className="border border-border/50 rounded-2xl px-6 bg-secondary/20 hover:bg-secondary/40 transition-colors overflow-hidden"
                >
                  <AccordionTrigger className="text-left text-lg font-medium py-6 hover:no-underline">
                    <span className="pr-4">{item.question}</span>
                  </AccordionTrigger>
                  {/*
                    forceMount：Radix 默认在收起态不渲染 Content，答案文本完全不进
                    SSR HTML，爬虫只能看到一个空壳。forceMount 后内容恒定在 DOM，
                    再用 data-[state=closed]:hidden 保持视觉收起。
                    这样 HTML 里始终有完整问答，且用户点击后看到的内容与之一致
                    （非 cloaking）。
                  */}
                  <AccordionContent
                    forceMount
                    contentClassName="data-[state=closed]:hidden"
                    className="text-muted-foreground leading-relaxed text-base pb-6 font-light"
                  >
                    {item.answer}
                    {item.action === "registration-code" && <RegistrationCodeCTA />}
                  </AccordionContent>
                </AccordionItem>
            ))}
          </Accordion>
        </AnimatedFeature>
      </div>
    </section>
  );
}
