/** @type {import('tailwindcss').Config} */
module.exports = {
    darkMode: ["class"],
    content: [
    "./src/**/*.{js,jsx,ts,tsx}",
    "./public/index.html"
  ],
  theme: {
        extend: {
                borderRadius: {
                        lg: 'var(--radius)',
                        md: 'calc(var(--radius) - 2px)',
                        sm: 'calc(var(--radius) - 4px)'
                },
                colors: {
                        // ===== Gen Z Digital Store Brand Colors =====
                        'genz-navy':      '#001030',
                        'genz-deep-navy': '#000820',
                        'genz-teal':      '#00AFC1',
                        'genz-dark-teal': '#008EA3',
                        'genz-white':     '#FFFFFF',
                        'genz-bg':        '#F8FBFC',
                        'genz-card':      '#FFFFFF',
                        'genz-border':    '#D9E4EA',
                        'genz-muted':     '#8A98A8',

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
                        'gradient-teal':    'linear-gradient(135deg, #00AFC1 0%, #008EA3 100%)',
                        'gradient-navy':    'linear-gradient(135deg, #001030 0%, #000820 100%)',
                        'gradient-genz':    'linear-gradient(135deg, #001030 0%, #00AFC1 100%)',
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
                        }
                },
                animation: {
                        'accordion-down': 'accordion-down 0.2s ease-out',
                        'accordion-up':   'accordion-up 0.2s ease-out',
                        'float':          'float 3s ease-in-out infinite',
                        'pulse-glow':     'pulse-glow 2s ease-in-out infinite',
                        'slide-in-up':    'slide-in-up 0.6s ease-out'
                }
        }
  },
  plugins: [require("tailwindcss-animate")],
};
