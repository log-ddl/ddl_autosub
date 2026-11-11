import type { Transition } from "motion/react";

/**
 * Animate UI motion tokens — unified springs, curves, scales, blurs, and shifts
 * for coherent, tactile UI motion across AutoSubs.
 */
export const ease = {
  out: [0.23, 1, 0.32, 1] as const,
  soft: [0.215, 0.61, 0.355, 1] as const,
  drawer: [0.34, 1.2, 0.64, 1] as const,
  draw: [0, 0, 0.58, 1] as const,
  inOut: [0.77, 0, 0.175, 1] as const,
  away: [0.33, 0.17, 0.67, 0.5] as const,
  in: [0.4, 0, 1, 1] as const,
  arrive: [0.11, 0, 0.5, 0] as const,
  color: [0.25, 0.1, 0.25, 1] as const,
  leave: [0, 0, 0.58, 1] as const,
  enter: [0.25, 0.1, 0.35, 1] as const,
  resize: [0.4, 0, 0.1, 1] as const,
  fill: [0.4, 0, 0.2, 1] as const,
};

export const spring: Record<string, Transition> = {
  press: { type: "spring", stiffness: 550, damping: 30, restSpeed: 10 },
  pop: { type: "spring", stiffness: 400, damping: 29 },
  tooltip: { type: "spring", stiffness: 400, damping: 31 },
  dialog: { type: "spring", stiffness: 150, damping: 25 },
  toast: { type: "spring", stiffness: 280, damping: 24 },
  selection: { type: "spring", stiffness: 300, damping: 30 },
  highlight: { type: "spring", stiffness: 500, damping: 40 },
  reflow: { type: "spring", stiffness: 500, damping: 40 },
  handoff: { type: "spring", stiffness: 450, damping: 43 },
  morph: { type: "spring", stiffness: 660, damping: 52 },
  height: { type: "spring", stiffness: 300, damping: 30, bounce: 0, restDelta: 0.01 },
  slide: { type: "spring", stiffness: 300, damping: 35, restDelta: 0.01 },
  thumb: { type: "spring", stiffness: 300, damping: 25 },
  slider: { type: "spring", stiffness: 400, damping: 32 },
  bounce: { type: "spring", stiffness: 200, damping: 16 },
  checkPop: { type: "spring", stiffness: 500, damping: 24 },
  entrance: { type: "spring", stiffness: 200, damping: 20 },
  progress: { type: "spring", stiffness: 300, damping: 35, restDelta: 0.01, restSpeed: 0.1 },
};

export const transition: Record<string, Transition> = {
  menu: { duration: 0.22, ease: ease.soft },
  overlay: { duration: 0.4, ease: ease.soft },
  dialogFade: { duration: 0.4, ease: ease.soft },
  fade: { duration: 0.2, ease: ease.out },
  color: { duration: 0.2, ease: ease.color },
  reveal: { duration: 0.3, ease: ease.out },
  disclosure: { duration: 0.35, ease: ease.soft },
  panelOut: { duration: 0.15, ease: ease.leave },
  panelIn: { duration: 0.3, ease: ease.enter },
  check: { duration: 0.3, delay: 0.08, ease: ease.draw },
  uncheck: { duration: 0.2, ease: ease.draw },
  fill: { duration: 0.3, ease: ease.fill },
  popOut: { duration: 0.15, ease: ease.out },
  swap: { duration: 0.15, ease: ease.out },
  spin: { duration: 0.3, ease: ease.out },
  collapse: { duration: 0.28, ease: ease.inOut },
  dismiss: { duration: 0.2, ease: ease.away },
  instant: { duration: 0 },
};

export const scale = {
  press: 0.97,
  choice: 0.985,
  tooltip: 0.7,
  popover: 0.8,
  menu: 0.9,
  dialog: 0.8,
  icon: 0.5,
  toast: 0.96,
  fill: 0.7,
  action: 0.9,
} as const;

export const blur = {
  tooltip: "blur(6px)",
  icon: "blur(2px)",
  disclosure: "blur(2px)",
  surface: "blur(4px)",
  panel: "blur(5px)",
} as const;

export const shift = {
  handoff: 6,
  navigation: 24,
  tabs: 12,
  step: 24,
  tooltip: 40,
  shake: 3,
} as const;
