"use client";

import type { Variants } from "motion/react";
import { motion, useAnimation } from "motion/react";
import type { HTMLAttributes } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";

import { cn } from "@/lib/utils";

export interface AudioLinesIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface AudioLinesIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
}

const BAR_VARIANTS: Variants = {
  normal: { scaleY: 1 },
  animate: (index: number) => ({
    scaleY: [1, 0.45, 1.15, 1],
    transition: {
      duration: 0.45,
      delay: index * 0.04,
      ease: "easeInOut",
    },
  }),
};

const AudioLinesIcon = forwardRef<AudioLinesIconHandle, AudioLinesIconProps>(
  ({ onMouseEnter, onMouseLeave, className, size = 28, ...props }, ref) => {
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

    const paths = [
      "M2 10v3",
      "M6 6v11",
      "M10 3v18",
      "M14 8v7",
      "M18 5v13",
      "M22 10v3",
    ];

    return (
      <div
        className={cn(className)}
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
          {paths.map((d, index) => (
            <motion.path
              key={d}
              d={d}
              custom={index}
              animate={controls}
              variants={BAR_VARIANTS}
              style={{ transformOrigin: "center" }}
            />
          ))}
        </svg>
      </div>
    );
  },
);

AudioLinesIcon.displayName = "AudioLinesIcon";

export { AudioLinesIcon };

