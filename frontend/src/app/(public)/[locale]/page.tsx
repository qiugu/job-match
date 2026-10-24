import LandingHeader from "@/components/home/LandingHeader";
import HeroSection from "@/components/home/HeroSection";
import FeaturesSection from "@/components/home/FeaturesSection";
import CTASection from "@/components/home/CTASection";
import Footer from "@/components/home/Footer";
import NewsAlert from "@/components/home/NewsAlert";
import FAQSection from "@/components/home/FAQSection";

export const runtime = "edge";
export default function LandingPage() {
  // 语义地标：header(nav) / main(内容) / footer 各自独立，避免全部塞进一个 div。
  // <main> 让屏幕阅读器与爬虫能直接定位主体内容，是落地页 SEO/可读性的基础结构。
  return (
    <>
      <LandingHeader />
      <main className="relative bg-paper" data-density="loud">
        <HeroSection />
        <FeaturesSection />
        <FAQSection />
        <CTASection />
      </main>
      <Footer />
    </>
  );
}
