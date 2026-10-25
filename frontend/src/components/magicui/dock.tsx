import { cn } from "@/lib/utils";
import React, { PropsWithChildren } from "react";
import { motion } from "framer-motion";

interface DockProps
  extends PropsWithChildren<React.HTMLAttributes<HTMLDivElement>> {
  className?: string;
}

export function Dock({ children, className, ...props }: DockProps) {
  // Convert children to array to handle them
  const childrenArray = React.Children.toArray(children);

  // Find the index of TemplateSheet for splitting
  const templateSheetIndex = childrenArray.findIndex((child) => {
    if (React.isValidElement(child)) {
      const tooltip = (child.props as { children?: React.ReactNode }).children;
      if (React.isValidElement(tooltip)) {
        const tooltipChildren = React.Children.toArray(
          (tooltip.props as { children?: React.ReactNode }).children
        );
        const trigger = tooltipChildren.find((item) => {
          if (!React.isValidElement(item)) return false;
          const type = item.type;
          return typeof type !== "string" && type.name === "TooltipTrigger";
        });
        if (trigger && React.isValidElement(trigger)) {
          const content = (
            trigger.props as { children?: React.ReactNode }
          ).children;
          if (React.isValidElement(content)) {
            const icon = (content.props as { children?: React.ReactNode }).children;
            return (
              React.isValidElement(icon) &&
              typeof icon.type !== "string" &&
              icon.type.name === "TemplateSheet"
            );
          }
        }
        return false;
      }
    }
    return false;
  });

  // If TemplateSheet is not found, render all children in a single group
  if (templateSheetIndex === -1) {
    return (
      <div
        {...props}
        className={cn(
          "flex flex-col items-center gap-4 rounded-xl bg-background p-2",
          className
        )}
      >
        <div className="flex flex-col items-center gap-4">{children}</div>
      </div>
    );
  }

  // Split children into three groups
  const topChildren = childrenArray.slice(0, templateSheetIndex);
  const middleChild = childrenArray[templateSheetIndex];
  const bottomChildren = childrenArray.slice(templateSheetIndex + 1);

  return (
    <div
      {...props}
      className={cn(
        "flex flex-col items-center gap-4 rounded-xl bg-background p-4",
        className
      )}
    >
      {/* Top group */}
      {topChildren.length > 0 && (
        <div className="flex flex-col items-center gap-4">{topChildren}</div>
      )}

      {/* Decorative line */}
      {topChildren.length > 0 && (
        <div className="w-8 h-px bg-border" />
      )}

      {/* Middle (TemplateSheet) */}
      {middleChild}

      {/* Decorative line */}
      {bottomChildren.length > 0 && (
        <div className="w-8 h-px bg-border" />
      )}

      {/* Bottom group */}
      {bottomChildren.length > 0 && (
        <div className="flex flex-col items-center gap-4">{bottomChildren}</div>
      )}
    </div>
  );
}

interface DockIconProps extends PropsWithChildren {
  className?: string;
  onClick?: () => void;
}

export function DockIcon({ children, className, onClick }: DockIconProps) {
  return (
    <motion.div
      whileHover={{ scale: 1.2 }}
      whileTap={{ scale: 0.95 }}
      className={cn(
        "flex size-8 items-center justify-center rounded-sm bg-background text-foreground transition-colors hover:bg-muted",
        className
      )}
      onClick={onClick}
    >
      {children}
    </motion.div>
  );
}
