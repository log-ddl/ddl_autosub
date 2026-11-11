"use client";

import type { Variants } from "motion/react";
import { motion, useAnimation } from "motion/react";
import type { HTMLAttributes } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";

import { cn } from "@/lib/utils";

export interface CaptionsIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface CaptionsIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
}

const LINE_VARIANTS: Variants = {
  normal: {
    pathLength: 1,
    opacity: 1,
  },
  animate: (custom: number) => ({
    pathLength: [0.3, 1],
    opacity: [0.5, 1],
    transition: {
      duration: 0.32,
      delay: custom * 0.06,
      ease: [0.23, 1, 0.32, 1],
    },
  }),
};

const CaptionsIcon = forwardRef<CaptionsIconHandle, CaptionsIconProps>(
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
          <rect width="18" height="14" x="3" y="5" rx="2" ry="2" />
          <motion.path
            d="M7 15h4"
            animate={controls}
            variants={LINE_VARIANTS}
            custom={0}
          />
          <motion.path
            d="M15 15h2"
            animate={controls}
            variants={LINE_VARIANTS}
            custom={1}
          />
          <motion.path
            d="M7 11h2"
            animate={controls}
            variants={LINE_VARIANTS}
            custom={2}
          />
          <motion.path
            d="M13 11h4"
            animate={controls}
            variants={LINE_VARIANTS}
            custom={3}
          />
        </svg>
      </div>
    );
  },
);

CaptionsIcon.displayName = "CaptionsIcon";

export { CaptionsIcon };
