import type { Variants } from "motion/react";

/** Fade in from below. Use with `motion.div` + `variants={fadeUp}`. */
export const fadeUp: Variants = {
	hidden: { opacity: 0, y: 16 },
	visible: { opacity: 1, y: 0 },
};

/** Fade in from the right. */
export const fadeRight: Variants = {
	hidden: { opacity: 0, x: 20 },
	visible: { opacity: 1, x: 0 },
};

/** Simple fade. */
export const fade: Variants = {
	hidden: { opacity: 0 },
	visible: { opacity: 1 },
};

/** Stagger children container. Pass `delayChildren` / `staggerChildren` in `transition`. */
export const stagger: Variants = {
	hidden: {},
	visible: { transition: { staggerChildren: 0.08 } },
};

/** Stagger with slower reveal for hero sections. */
export const heroStagger: Variants = {
	hidden: {},
	visible: { transition: { staggerChildren: 0.12, delayChildren: 0.1 } },
};
