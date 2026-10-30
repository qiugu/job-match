import { useEffect, useState } from "react";
import { Star } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { GITHUB_API_REPO_URL, GITHUB_REPO_URL } from "@/config/constants";

export function GitHubStars() {
  const [stars, setStars] = useState<number | null>(null);
  const [isHovered, setIsHovered] = useState(false);

  useEffect(() => {
    fetch(GITHUB_API_REPO_URL)
      .then((res) => res.json())
      .then((data) => {
        // 匿名 API 有速率限制，可能返回 { message } 而非仓库对象；
        // 非数值时保持 stars = null，隐藏分隔线与数字，避免渲染出空槽/NaN。
        if (typeof data?.stargazers_count === "number") {
          setStars(data.stargazers_count);
        }
      })
      .catch((error) => {
        console.error("Error fetching GitHub stars:", error);
      });
  }, []);

  return (
    <motion.a
      href={GITHUB_REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "relative inline-flex items-center gap-2 h-8 px-3 rounded-full",
        "bg-background dark:bg-background",
        "border border-border dark:border-white/20",
        "hover:border-border/80 dark:hover:border-white/40",
        "shadow-chip",
        "cursor-pointer select-none",
        "group overflow-hidden"
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <motion.div
        className="relative z-10 flex items-center"
        animate={isHovered ? { rotate: 180 } : { rotate: 0 }}
        transition={{ duration: 0.3 }}
      >
        <Star
          className={cn(
            "h-4 w-4",
            "text-ink-3",
            "transition-colors duration-300",
            isHovered && "text-amber-ink"
          )}
          fill={isHovered ? "currentColor" : "none"}
        />
      </motion.div>

      <span className="relative z-10 text-sm font-medium">Star on GitHub</span>

      {stars !== null && (
        <>
          <span
            className={cn(
              "relative z-10 w-px h-3",
              "bg-border/60 dark:bg-white/20",
              "transition-colors duration-300"
            )}
          />
          <motion.span
            className="relative z-10 text-sm tabular-nums"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.1 }}
          >
            {stars?.toLocaleString()}
          </motion.span>
        </>
      )}
    </motion.a>
  );
}
