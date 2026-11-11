"use client";

import type { Variants } from "motion/react";
import { motion, useAnimation } from "motion/react";
import type { HTMLAttributes } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";

import { cn } from "@/lib/utils";

export interface SparklesIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface SparklesIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
}

const STAR_VARIANTS: Variants = {
  normal: {
    scale: 1,
    rotate: 0,
  },
  animate: {
    scale: [1, 1.12, 1],
    rotate: [0, 12, -6, 0],
    transition: {
      duration: 0.45,
      ease: [0.23, 1, 0.32, 1],
    },
  },
};

const TWINKLE_VARIANTS: Variants = {
  normal: {
    scale: 1,
    opacity: 1,
  },
  animate: (custom: number) => ({
    scale: [1, 0.4, 1.25, 1],
    opacity: [1, 0.4, 1],
    transition: {
      duration: 0.42,
      delay: custom * 0.08,
      ease: "easeOut",
    },
  }),
};

const SparklesIcon = forwardRef<SparklesIconHandle, SparklesIconProps>(
  ({ onMouseEnter, onMouseLeave, className, size = 16, ...props }, ref) => {
    const controls = useAnimation();
    const isControlledRef = useRef(false);

    useImperativeHandle(ref, () => {
      isControlledRef.current = true;
      return {
        startAnimation: () => controls.start("animate"),
        stopAnimation: () => controls.start("normal"),
      };
    });

    const handleMouseEnter = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (isControlledRef.current) {
          onMouseEnter?.(e);
        } else {
          controls.start("animate");
        }
      },
      [controls, onMouseEnter],
    );

    const handleMouseLeave = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (isControlledRef.current) {
          onMouseLeave?.(e);
        } else {
          controls.start("normal");
        }
      },
      [controls, onMouseLeave],
    );

    return (
      <div
        className={cn("inline-flex items-center justify-center", className)}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        {...props}
      >
        <svg
          fill="none"
          height={size}
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width={size}
          xmlns="http://www.w3.org/2000/svg"
        >
          <motion.path
            d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"
            animate={controls}
            variants={STAR_VARIANTS}
            style={{ originX: "12px", originY: "12px" }}
          />
          <motion.path
            d="M20 3v4M22 5h-4"
            animate={controls}
            variants={TWINKLE_VARIANTS}
            custom={0}
            style={{ originX: "20px", originY: "5px" }}
          />
          <motion.path
            d="M4 17v2M5 18H3"
            animate={controls}
            variants={TWINKLE_VARIANTS}
            custom={1}
            style={{ originX: "4px", originY: "18px" }}
          />
        </svg>
      </div>
    );
  },
);

SparklesIcon.displayName = "SparklesIcon";

export { SparklesIcon };
