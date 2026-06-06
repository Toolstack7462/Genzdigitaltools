import { motion, useScroll, useSpring, useReducedMotion } from 'framer-motion';

/**
 * Premium scroll-progress indicator pinned to the top of public pages.
 * A thin teal gradient bar that fills as the page scrolls.
 * Respects prefers-reduced-motion: when reduced, the spring smoothing is
 * dropped so the bar tracks scroll position directly with no easing motion.
 */
const ScrollProgress = () => {
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, {
    stiffness: reduce ? 1000 : 120,
    damping: reduce ? 100 : 30,
    restDelta: 0.001,
  });

  return (
    <motion.div
      aria-hidden="true"
      style={{
        scaleX,
        transformOrigin: '0% 50%',
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: '3px',
        zIndex: 60,
        background: 'linear-gradient(90deg, #008EA3, #00AFC1, #7DF9FF)',
        boxShadow: '0 0 12px rgba(0,175,193,0.5)',
      }}
    />
  );
};

export default ScrollProgress;
