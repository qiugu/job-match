import { subtle } from "crypto";
import type { Config } from "tailwindcss";
const { heroui } = require("@heroui/react");

const config = {
  // dark: 变体跟随 html 层 class（next-themes attribute="class"）。
  // .theme-xai 作用域内通过 globals.css 的 html.light/.dark 变量翻转，
  // 组件应优先用语义 token 与 xai-* 变量色，而非依赖 dark:。
  darkMode: ["class"],
  content: [
    "./pages/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./app/**/*.{ts,tsx}",
    "./src/**/*.{ts,tsx}",
    "./node_modules/@heroui/theme/dist/**/*.{js,ts,jsx,tsx}",
    "./node_modules/streamdown/dist/*.js"
  ],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px"
      }
    },
    extend: {
      fontFamily: {
        /* Paper & Punch：展示体 / 正文体 / 等宽体（中文回落 PingFang/雅黑） */
        display: ["Bricolage Grotesque", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "system-ui", "sans-serif"],
        sans: ["Instrument Sans", "Noto Sans SC", "PingFang SC", "system-ui", "sans-serif"],
        mono: ["DM Mono", "Geist Mono", "ui-monospace", "SFMono-Regular", "monospace"],
        serif: ["Newsreader", "serif"],
      },
      colors: {
        /* Paper & Punch 令牌（docs/DESIGN.md §4），与 globals.css :root 同源 */
        paper: {
          DEFAULT: "var(--paper)",
          2: "var(--paper-2)",
        },
        ppcard: "var(--pp-card)",
        ink: {
          DEFAULT: "var(--ink)",
          2: "var(--ink-2)",
          3: "var(--ink-3)",
        },
        line: {
          DEFAULT: "var(--line)",
          strong: "var(--line-strong)",
        },
        cobalt: {
          DEFAULT: "var(--cobalt)",
          deep: "var(--cobalt-deep)",
        },
        tangerine: "var(--tangerine)",
        mint: "var(--mint)",
        butter: "var(--butter)",
        blush: "var(--blush)",
        "green-ink": "var(--green-text)",
        "amber-ink": "var(--amber-text)",
        danger: "var(--danger)",
        "punch-shadow": "var(--shadow-color)",
        /* xAI 深色语义色板 —— 与 globals.css 的 --xai-* 变量同源 */
        xai: {
          canvas: "var(--xai-canvas)",
          surface: "var(--xai-surface)",
          "surface-2": "var(--xai-surface-2)",
          hairline: "var(--xai-hairline)",
          "hairline-soft": "var(--xai-hairline-soft)",
          "hairline-strong": "var(--xai-hairline-strong)",
          text: "var(--xai-text)",
          "text-mid": "var(--xai-text-mid)",
          mute: "var(--xai-mute)",
          eyebrow: "var(--xai-eyebrow)",
          success: "var(--xai-success)",
          add: "var(--xai-add)",
          "add-bg": "var(--xai-add-bg)",
          del: "var(--xai-del)",
          "del-bg": "var(--xai-del-bg)",
        },
        baseFont: "#212529",
        subtitleFont: "#212529",
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))"
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))"
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))"
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))"
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))"
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))"
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))"
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))"
        },
        chart: {
          "1": "hsl(var(--chart-1))",
          "2": "hsl(var(--chart-2))",
          "3": "hsl(var(--chart-3))",
          "4": "hsl(var(--chart-4))",
          "5": "hsl(var(--chart-5))"
        }
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)"
      },
      /* Paper & Punch 硬偏移阴影（禁 blur > 2px；随 [data-density] 切换） */
      boxShadow: {
        punch: "var(--shadow-card)",
        chip: "var(--shadow-chip)",
      },
      keyframes: {
        "accordion-down": {
          from: {
            height: "0"
          },
          to: {
            height: "var(--radix-accordion-content-height)"
          }
        },
        "accordion-up": {
          from: {
            height: "var(--radix-accordion-content-height)"
          },
          to: {
            height: "0"
          }
        },
        "fade-in": {
          "0%": {
            opacity: "0",
            transform: "scale(0.95)"
          },
          "100%": {
            opacity: "1",
            transform: "scale(1)"
          }
        },
        "fade-out": {
          "0%": {
            opacity: "1",
            transform: "scale(1)"
          },
          "100%": {
            opacity: "0",
            transform: "scale(0.98)"
          }
        }
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "fade-in": "fade-in 0.4s cubic-bezier(0.16, 1, 0.3, 1)",
        "fade-out": "fade-out 0.4s cubic-bezier(0.16, 1, 0.3, 1)"
      }
    }
  },
  plugins: [require("tailwindcss-animate"), heroui()]
} satisfies Config;

export default config;
