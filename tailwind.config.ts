import type { Config } from "tailwindcss";

/**
 * The palette is the six brand colours and nothing else: `#ffffff`, `#094454`,
 * `#25a7e5`, `#fdf0df`, `#7aabb0`, `#fbae80`. Colour values live as CSS
 * variables in globals.css, where the light and dark themes assign those six to
 * different roles — see the header comment there for which pairs are legible.
 */
const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx,mdx}"],
  theme: {
    /**
     * Tailwind's own defaults are greys, blacks and a blue ring. None of them are
     * in this palette, and preflight applies several of them to elements that
     * carry no colour class at all — so the defaults are replaced rather than
     * left to leak into the compiled stylesheet.
     */
    borderColor: ({ theme }) => ({
      ...theme("colors"),
      DEFAULT: "rgb(var(--line) / <alpha-value>)",
    }),
    divideColor: ({ theme }) => ({
      ...theme("colors"),
      DEFAULT: "rgb(var(--line) / <alpha-value>)",
    }),
    placeholderColor: ({ theme }) => ({
      ...theme("colors"),
      DEFAULT: "rgb(var(--ink-subtle) / <alpha-value>)",
    }),
    extend: {
      /**
       * The focus ring's default colour lives in Tailwind's ring plugin, which
       * reads it from `ringColor.DEFAULT` — declared here (rather than beside the
       * other defaults above) because the plugin resolves it through `extend`.
       */
      ringColor: ({ theme }) => ({
        ...theme("colors"),
        DEFAULT: "rgb(var(--cyan-500) / <alpha-value>)",
      }),
      ringOffsetColor: ({ theme }) => ({
        ...theme("colors"),
        DEFAULT: "rgb(var(--surface) / <alpha-value>)",
      }),
      colors: {
        navy: {
          DEFAULT: "rgb(var(--navy) / <alpha-value>)",
          50: "rgb(var(--navy-50) / <alpha-value>)",
          100: "rgb(var(--navy-100) / <alpha-value>)",
          200: "rgb(var(--navy-200) / <alpha-value>)",
          300: "rgb(var(--navy-300) / <alpha-value>)",
          400: "rgb(var(--navy-400) / <alpha-value>)",
          500: "rgb(var(--navy-500) / <alpha-value>)",
          600: "rgb(var(--navy-600) / <alpha-value>)",
          700: "rgb(var(--navy-700) / <alpha-value>)",
          800: "rgb(var(--navy-800) / <alpha-value>)",
          900: "rgb(var(--navy-900) / <alpha-value>)",
        },
        cyan: {
          DEFAULT: "rgb(var(--cyan) / <alpha-value>)",
          50: "rgb(var(--cyan-50) / <alpha-value>)",
          100: "rgb(var(--cyan-100) / <alpha-value>)",
          200: "rgb(var(--cyan-200) / <alpha-value>)",
          300: "rgb(var(--cyan-300) / <alpha-value>)",
          400: "rgb(var(--cyan-400) / <alpha-value>)",
          500: "rgb(var(--cyan-500) / <alpha-value>)",
          600: "rgb(var(--cyan-600) / <alpha-value>)",
          700: "rgb(var(--cyan-700) / <alpha-value>)",
        },
        cream: {
          DEFAULT: "rgb(var(--cream) / <alpha-value>)",
          50: "rgb(var(--cream-50) / <alpha-value>)",
          100: "rgb(var(--cream-100) / <alpha-value>)",
          200: "rgb(var(--cream-200) / <alpha-value>)",
          300: "rgb(var(--cream-300) / <alpha-value>)",
        },
        ember: {
          DEFAULT: "rgb(var(--ember) / <alpha-value>)",
          400: "rgb(var(--ember-400) / <alpha-value>)",
          500: "rgb(var(--ember-500) / <alpha-value>)",
          600: "rgb(var(--ember-600) / <alpha-value>)",
        },
        surface: {
          DEFAULT: "rgb(var(--surface) / <alpha-value>)",
          muted: "rgb(var(--surface-muted) / <alpha-value>)",
          raised: "rgb(var(--surface-raised) / <alpha-value>)",
        },
        line: {
          DEFAULT: "rgb(var(--line) / <alpha-value>)",
          strong: "rgb(var(--line-strong) / <alpha-value>)",
        },
        ink: {
          DEFAULT: "rgb(var(--ink) / <alpha-value>)",
          muted: "rgb(var(--ink-muted) / <alpha-value>)",
          subtle: "rgb(var(--ink-subtle) / <alpha-value>)",
          inverted: "rgb(var(--ink-inverted) / <alpha-value>)",
        },
        /** Strong neutral fill with its own legible ink. */
        solid: {
          DEFAULT: "rgb(var(--solid) / <alpha-value>)",
          ink: "rgb(var(--solid-ink) / <alpha-value>)",
        },
        info: "rgb(var(--info) / <alpha-value>)",
        success: "rgb(var(--success) / <alpha-value>)",
        warning: "rgb(var(--warning) / <alpha-value>)",
        danger: "rgb(var(--danger) / <alpha-value>)",
      },
      fontFamily: {
        display: ["var(--font-display)", "Georgia", "serif"],
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      borderRadius: {
        xl: "0.875rem",
        "2xl": "1.25rem",
        "3xl": "1.75rem",
      },
      boxShadow: {
        card: "0 1px 2px rgb(var(--shadow) / 0.06), 0 8px 24px -12px rgb(var(--shadow) / 0.18)",
        rail: "0 1px 0 rgb(var(--line) / 1)",
        pop: "0 18px 40px -20px rgb(var(--shadow) / 0.35)",
        // Tailwind's default elevations are pure black; re-tinted to the brand
        // shadow colour, since the palette has no black in it.
        sm: "0 1px 2px 0 rgb(var(--shadow) / 0.08)",
        lg: "0 10px 22px -8px rgb(var(--shadow) / 0.28)",
      },
      backgroundImage: {
        "grid-fade":
          "radial-gradient(circle at 1px 1px, rgb(var(--line-strong) / 0.35) 1px, transparent 0)",
        "brand-sheen": "linear-gradient(135deg, rgb(var(--cyan-400)) 0%, rgb(var(--cyan-500)) 100%)",
      },
      keyframes: {
        "cat-bob": {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-3px)" },
        },
        "dots-pulse": {
          "0%, 80%, 100%": { opacity: "0.25", transform: "scale(0.85)" },
          "40%": { opacity: "1", transform: "scale(1)" },
        },
        "sweep-in": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "cat-bob": "cat-bob 1.6s ease-in-out infinite",
        "dots-pulse": "dots-pulse 1.2s ease-in-out infinite",
        "sweep-in": "sweep-in 220ms ease-out both",
      },
      transitionTimingFunction: {
        brand: "cubic-bezier(0.22, 1, 0.36, 1)",
      },
    },
  },
  plugins: [],
};

export default config;
