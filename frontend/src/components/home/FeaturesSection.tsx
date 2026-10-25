
import { useTranslations } from "@/i18n/compat/client";
import Image from "@/lib/image";
import { useState, useEffect, useRef, useCallback } from "react";
import { ChevronRight, Sparkles, Shield, Zap } from "lucide-react";
import AnimatedFeature from "./client/AnimatedFeature";

const features = [
  {
    icon: Sparkles,
    badge: "features.ai.badge",
    badgeColor: "bg-primary/10 text-primary",
    title: "features.ai.title",
    description: "features.ai.description",
    items: [
      {
        title: "features.ai.item1",
        description: "features.ai.item1_description",
        image: "/features/svg/polish.svg",
      },
      {
        title: "features.ai.item2",
        description: "features.ai.item2_description",
        image: "/features/svg/grammar.svg",
      },
    ],
  },
  {
    icon: Shield,
    badge: "features.storage.badge",
    badgeColor: "bg-mint text-green-ink",
    title: "features.storage.title",
    description: "features.storage.description",
    items: [
      {
        title: "features.storage.item1",
        description: "features.storage.item1_description",
        image: "/features/svg/local-storage.svg",
      },
      {
        title: "features.storage.item2",
        description: "features.storage.item2_description",
        image: "/features/svg/export-formats.svg",
      },
    ],
  },
] as const;

const SLIDE_DURATION = 6000;

export default function FeaturesSection() {
  const t = useTranslations("home");
  const [activeFeatures, setActiveFeatures] = useState<number[]>(
    features.map(() => 0)
  );
  const [progresses, setProgresses] = useState<number[]>(features.map(() => 0));
  const intervalRefs = useRef<(NodeJS.Timeout | null)[]>(
    features.map(() => null)
  );

  const startProgressTimer = useCallback(
    (categoryIndex: number) => {
      if (intervalRefs.current[categoryIndex]) {
        clearInterval(intervalRefs.current[categoryIndex] as NodeJS.Timeout);
      }

      const updateInterval = 50;
      const progressIncrement = (updateInterval / SLIDE_DURATION) * 100;

      intervalRefs.current[categoryIndex] = setInterval(() => {
        setProgresses((prev) => {
          const newProgresses = [...prev];
          // Allow progress to go slightly over 100, handled by effect
          if (newProgresses[categoryIndex] < 100) {
            newProgresses[categoryIndex] += progressIncrement;
          }
          return newProgresses;
        });
      }, updateInterval);
    },
    []
  );

  // Handle auto-switch when progress reaches 100%
  useEffect(() => {
    progresses.forEach((progress, index) => {
      if (progress >= 100) {
        // Reset progress immediately to prevent repeated triggers
        setProgresses((prev) => {
          const next = [...prev];
          next[index] = 0;
          return next;
        });
        
        // Switch to next feature
        setActiveFeatures((prevActive) => {
          const next = [...prevActive];
          const max = features[index].items.length - 1;
          next[index] = next[index] < max ? next[index] + 1 : 0;
          return next;
        });
      }
    });
  }, [progresses]);

  useEffect(() => {
    features.forEach((_, index) => startProgressTimer(index));
    return () => {
      intervalRefs.current.forEach((ref) => {
        if (ref) clearInterval(ref);
      });
    };
  }, [startProgressTimer]);

  const handleSlideChange = (categoryIndex: number, featureIndex: number) => {
    setActiveFeatures((prev) => {
      const next = [...prev];
      next[categoryIndex] = featureIndex;
      return next;
    });
    setProgresses((prev) => {
      const next = [...prev];
      next[categoryIndex] = 0;
      return next;
    });
    startProgressTimer(categoryIndex);
  };

  return (
    <section className="py-24 md:py-40 bg-paper-2 overflow-hidden">
      <div className="container mx-auto px-6 max-w-6xl">
        <AnimatedFeature>
          <div className="text-center mb-24 md:mb-32">
            <h2 className="text-4xl md:text-5xl font-display font-extrabold tracking-tight text-ink mb-6">
              {t("features.title")}
            </h2>
            <div className="w-16 h-2 bg-cobalt mx-auto mb-8" />
            <p className="text-xl text-ink-2 max-w-2xl mx-auto leading-relaxed">
              {t("features.subtitle")}
            </p>
          </div>
        </AnimatedFeature>

        <div className="space-y-40">
          {features.map((category, catIndex) => (
            <div
              key={catIndex}
              className={`flex flex-col gap-16 lg:gap-24 items-center ${
                catIndex % 2 === 1 ? "lg:flex-row-reverse" : "lg:flex-row"
              }`}
            >
              {/* Text Side */}
              <div className="w-full lg:w-5/12 space-y-10">
                <AnimatedFeature delay={0.1}>
                  <div className="space-y-6">
                    <div className="inline-flex items-center gap-2 rounded-lg border-2 border-ink bg-ppcard px-3 py-1 text-sm font-semibold text-ink shadow-chip">
                      <category.icon className="w-4 h-4" />
                      {t(category.badge)}
                    </div>
                    <h3 className="text-3xl md:text-4xl font-display font-bold tracking-tight text-ink">
                      {t(category.title)}
                    </h3>
                    <p className="text-lg text-ink-2 leading-relaxed">
                      {t(category.description)}
                    </p>
                  </div>
                </AnimatedFeature>

                <div className="space-y-4">
                  {category.items.map((item, itemIndex) => (
                    <button
                      key={itemIndex}
                      onClick={() => handleSlideChange(catIndex, itemIndex)}
                      className={`w-full text-left group p-5 rounded-xl transition-all relative border-2 overflow-hidden ${
                        activeFeatures[catIndex] === itemIndex
                          ? "bg-ppcard border-ink shadow-chip -translate-x-0.5 -translate-y-0.5"
                          : "bg-transparent border-transparent hover:border-line-strong"
                      }`}
                    >
                      {/* Progress Bar */}
                      {activeFeatures[catIndex] === itemIndex && (
                        <div
                          className="absolute bottom-0 left-0 h-1 bg-cobalt transition-all duration-75 ease-linear"
                          style={{ width: `${progresses[catIndex]}%` }}
                        />
                      )}

                      <div className="flex items-start justify-between">
                        <div className="space-y-1">
                          <h4 className={`font-semibold transition-colors ${
                            activeFeatures[catIndex] === itemIndex ? "text-cobalt" : "text-ink"
                          }`}>
                            {t(item.title)}
                          </h4>
                          <p className="text-sm text-ink-3 line-clamp-1">
                            {t(item.description)}
                          </p>
                        </div>
                        <ChevronRight className={`w-5 h-5 transition-all ${
                          activeFeatures[catIndex] === itemIndex ? "text-cobalt translate-x-1" : "text-ink-3"
                        }`} />
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Image Side */}
              <div className="w-full lg:w-7/12">
                <AnimatedFeature key={`${catIndex}-${activeFeatures[catIndex]}`} delay={0.2}>
                  <div className="relative aspect-[16/10] bg-ppcard rounded-2xl border-2 border-ink p-6 sm:p-10 shadow-punch overflow-hidden">
                    <div className="relative w-full h-full">
                      <Image
                        src={category.items[activeFeatures[catIndex]].image}
                        alt={t(category.items[activeFeatures[catIndex]].title)}
                        fill
                        className="object-contain"
                        sizes="(max-width: 1024px) 100vw, 40vw"
                      />
                    </div>
                  </div>
                </AnimatedFeature>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
