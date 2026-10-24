import { useState, useEffect } from "react";
import { useScroll } from "framer-motion";

interface ScrollHeaderProps {
  children: React.ReactNode;
}

export default function ScrollHeader({ children }: ScrollHeaderProps) {
  const { scrollY } = useScroll();
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    const unsubscribe = scrollY.on("change", (latest) => {
      setIsScrolled(latest > 0);
    });

    return () => {
      unsubscribe();
    };
  }, [scrollY]);

  return (
    <header
      className={`fixed top-0 left-0 w-full z-50 transition-colors duration-200 ${
        isScrolled
          ? "bg-paper/95 border-b-2 border-ink"
          : "bg-transparent"
      }`}
    >
      {children}
    </header>
  );
}
