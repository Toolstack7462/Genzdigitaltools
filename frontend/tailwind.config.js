/** @type {import('tailwindcss').Config} */
module.exports = {
    darkMode: ["class"],
    content: [
    "./src/**/*.{js,jsx,ts,tsx}",
    "./public/index.html"
  ],
  theme: {
        extend: {
                fontFamily: {
                        sans: ['Inter', 'system-ui', 'sans-serif'],
                        heading: ['Sora', 'Space Grotesk', 'Inter', 'sans-serif'],
                        mono: ['JetBrains Mono', 'SFMono-Regular', 'Consolas', 'monospace']
                },
                borderRadius: {
                        lg: 'var(--radius)',
                        md: 'calc(var(--radius) - 2px)',
                        sm: 'calc(var(--radius) - 4px)'
                },
                colors: {
                        // ===== Gen Z Digital Store Brand Colors =====
                        'genz-navy':      '#071B33',
                        'genz-deep-navy': '#000820',
                        'genz-blue':      '#2563EB',
                        'genz-cyan':      '#06B6D4',
                        'genz-teal':      '#06B6D4',
                        'genz-dark-teal': '#14B8A6',
                        'genz-white':     '#FFFFFF',
                        'genz-bg':        '#F6F9FC',
                        'genz-card':      '#FFFFFF',
                        'genz-border':    '#D9E7F0',
                        'genz-muted':     '#5B6B7C',

                        // ===== Backward Compatibility Aliases =====
                        // Old Gen Z Digital Store colors mapped to new Gen Z colors
                        'toolstack-orange':      '#00AFC1',
                        'toolstack-dark-orange': '#008EA3',
                        'toolstack-bg':          '#001030',
                        'toolstack-card':        '#FFFFFF',
                        'toolstack-border':      '#D9E4EA',
                        'toolstack-muted':       '#8A98A8',

                        // Shadcn defaults
                        background: 'hsl(var(--background))',
                        foreground: 'hsl(var(--foreground))',
                        card: {
                                DEFAULT: 'hsl(var(--card))',
                                foreground: 'hsl(var(--card-foreground))'
                        },
                        popover: {
                                DEFAULT: 'hsl(var(--popover))',
                                foreground: 'hsl(var(--popover-foreground))'
                        },
                        primary: {
                                DEFAULT: 'hsl(var(--primary))',
                                foreground: 'hsl(var(--primary-foreground))'
                        },
                        secondary: {
                                DEFAULT: 'hsl(var(--secondary))',
                                foreground: 'hsl(var(--secondary-foreground))'
                        },
                        muted: {
                                DEFAULT: 'hsl(var(--muted))',
                                foreground: 'hsl(var(--muted-foreground))'
                        },
                        accent: {
                                DEFAULT: 'hsl(var(--accent))',
                                foreground: 'hsl(var(--accent-foreground))'
                        },
                        destructive: {
                                DEFAULT: 'hsl(var(--destructive))',
                                foreground: 'hsl(var(--destructive-foreground))'
                        },
                        border: 'hsl(var(--border))',
                        input: 'hsl(var(--input))',
                        ring: 'hsl(var(--ring))',
                        chart: {
                                '1': 'hsl(var(--chart-1))',
                                '2': 'hsl(var(--chart-2))',
                                '3': 'hsl(var(--chart-3))',
                                '4': 'hsl(var(--chart-4))',
                                '5': 'hsl(var(--chart-5))'
                        }
                },
                backgroundImage: {
                        'gradient-teal':    'linear-gradient(135deg, #2563EB 0%, #06B6D4 45%, #14B8A6 100%)',
                        'gradient-navy':    'linear-gradient(135deg, #071B33 0%, #0B2747 100%)',
                        'gradient-genz':    'linear-gradient(135deg, #2563EB 0%, #06B6D4 45%, #14B8A6 100%)',
                        // Backward compat
                        'gradient-orange':  'linear-gradient(135deg, #00AFC1 0%, #008EA3 100%)'
                },
                keyframes: {
                        'accordion-down': {
                                from: { height: '0' },
                                to:   { height: 'var(--radix-accordion-content-height)' }
                        },
                        'accordion-up': {
                                from: { height: 'var(--radix-accordion-content-height)' },
                                to:   { height: '0' }
                        },
                        'float': {
                                '0%, 100%': { transform: 'translateY(0px)' },
                                '50%':      { transform: 'translateY(-10px)' }
                        },
                        'pulse-glow': {
                                '0%, 100%': { boxShadow: '0 0 20px rgba(0,175,193,0.3)' },
                                '50%':      { boxShadow: '0 0 40px rgba(0,175,193,0.6)' }
                        },
                        'slide-in-up': {
                                from: { opacity: '0', transform: 'translateY(30px)' },
                                to:   { opacity: '1', transform: 'translateY(0)' }
                        },
                        'fade-in': {
                                from: { opacity: '0' },
                                to:   { opacity: '1' }
                        },
                        'scale-in': {
                                from: { opacity: '0', transform: 'scale(0.94)' },
                                to:   { opacity: '1', transform: 'scale(1)' }
                        },
                        'shimmer': {
                                '0%':   { backgroundPosition: '-200% center' },
                                '100%': { backgroundPosition: '200% center' }
                        }
                },
                animation: {
                        'accordion-down': 'accordion-down 0.2s ease-out',
                        'accordion-up':   'accordion-up 0.2s ease-out',
                        'float':          'float 3s ease-in-out infinite',
                        'pulse-glow':     'pulse-glow 2s ease-in-out infinite',
                        'slide-in-up':    'slide-in-up 0.6s ease-out',
                        'fade-in':        'fade-in 0.5s ease-out',
                        'scale-in':       'scale-in 0.5s ease-out',
                        'shimmer':        'shimmer 2s linear infinite'
                }
        }
  },
  plugins: [require("tailwindcss-animate")],
};
