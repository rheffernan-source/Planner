/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      // ---------------------------------------------------------------
      // Prism design tokens (Phase 7 visual restyle).
      // Pulled from the approved "Frosted Neon" glassmorphism concept —
      // electric blue/violet accents on a pale glass base. Values match
      // the reference 1:1 so the two stay traceable to the same source.
      //
      // NOT duplicated here: plain white-at-opacity "glass" surfaces
      // (bg-white/55, border-white/65, etc.) — Tailwind's own opacity
      // modifiers already express that without a redundant token, so
      // components use those directly rather than a `prism-surface` color.
      // ---------------------------------------------------------------
      colors: {
        prism: {
          base: '#eef1f7',
          ink: '#12142a',
          muted: '#5b6072',
          blue: '#3f7cff',
          'blue-deep': '#2f5fdb',
          violet: '#8b5cf6',
          'violet-deep': '#6d3fd1',
          navy: '#1b2140',
          // Darkened blue for small text/pill labels sitting on a light
          // --blue-tint wash, where --blue itself doesn't clear 4.5:1.
          // Carried forward from the reference's own Vera-QA-driven fix.
          'pill-blue-text': '#2851ba',
        },
      },
      fontFamily: {
        // Overrides Tailwind's default sans/mono so every unadorned
        // element (Tailwind's preflight applies `sans` to `html`) picks
        // up the Prism type pairing without a hand-rolled CSS override.
        sans: ['"Plus Jakarta Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['Sora', '"Plus Jakarta Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      backgroundImage: {
        // Text-safe gradient (blue-deep -> navy) for solid CTA buttons —
        // both stops individually clear 4.5:1 with white text.
        'prism-cta': 'linear-gradient(135deg, #2f5fdb, #1b2140)',
        // Text-safe gradient (blue-deep -> violet-deep) for avatar-style
        // chips / "today" markers carrying white text.
        'prism-a11y': 'linear-gradient(145deg, #2f5fdb, #6d3fd1)',
        // Decorative-only gradient (progress bars, chart fills) — never
        // put text directly on this one, use prism-a11y instead.
        'prism-accent': 'linear-gradient(90deg, #3f7cff, #8b5cf6)',
        // Soft tint wash for active/selected chrome (nav-active-style).
        'prism-tint': 'linear-gradient(120deg, rgba(63,124,255,0.14), rgba(139,92,246,0.14))',
        // Ambient background blobs — decorative, aria-hidden, sit behind
        // every glass surface. Radial fades so they blend into the base.
        'prism-blob-blue': 'radial-gradient(circle at 30% 30%, #3f7cff, transparent 70%)',
        'prism-blob-violet': 'radial-gradient(circle at 60% 60%, #8b5cf6, transparent 70%)',
        'prism-blob-navy': 'radial-gradient(circle, #1b2140, transparent 72%)',
      },
      boxShadow: {
        'prism-card': '0 24px 60px -24px rgba(18,20,42,0.28), 0 2px 10px rgba(18,20,42,0.05)',
        'prism-soft': '0 2px 8px rgba(18,20,42,0.07)',
        'prism-cta': '0 10px 24px -10px rgba(47,95,219,0.6)',
      },
      blur: {
        'prism-blob': '90px',
      },
      keyframes: {
        'prism-flap': {
          '0%': { opacity: '0', transform: 'rotateX(-90deg)' },
          '60%': { opacity: '1' },
          '100%': { opacity: '1', transform: 'rotateX(0deg)' },
        },
        'prism-toast': {
          '0%': { opacity: '0', transform: 'translateY(14px) scale(0.97)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },
      animation: {
        'prism-flap': 'prism-flap 0.45s ease-out',
        'prism-toast': 'prism-toast 0.3s cubic-bezier(0.34,1.56,0.64,1)',
      },
    },
  },
  plugins: [],
};
