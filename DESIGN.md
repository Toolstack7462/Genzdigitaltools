# Gen Z Digital Store — Design System

> **Brand:** Gen Z Digital Store
> **Positioning:** Premium Digital Tools & Services in One Place
> **Target feel:** Premium 2026 SaaS × digital agency × digital-services marketplace — smooth, custom, trustworthy, conversion-focused.

This file is the single visual standard for the website (`genzdigitalstore.com`) and the web app (`app.genzdigitalstore.com`). All new and refactored UI must follow it. When in doubt, match the tokens and utilities defined here rather than inventing new values.

---

## 1. Brand Colors

| Token | Hex | Usage |
|-------|-----|-------|
| `--genz-deep-navy` | `#000820` | App background base (darkest) |
| `--genz-navy` | `#001030` | Section / elevated background |
| `--genz-navy-2` | `#001A3D` | Cards on navy, raised surfaces |
| `--genz-teal` | `#00AFC1` | Primary accent, CTAs, active states |
| `--genz-cyan` | `#7DF9FF` | Highlight, gradient peak, glow |
| `--genz-dark-teal` | `#008EA3` | Gradient base, pressed states |
| `--genz-white` | `#FFFFFF` | Primary text on dark |

### Accent palette (category coding only — never decorative)
Used to differentiate service/tool categories. Always muted on dark surfaces.

| Purpose | Hex |
|---------|-----|
| Tools / Primary | `#00AFC1` |
| Social media | `#E1306C` |
| Writing / Academic | `#A78BFA` |
| Web design | `#00AFC1` |
| App development | `#4ADE80` |
| Branding | `#FB923C` |
| SEO / Growth | `#60A5FA` |
| Success | `#4ADE80` |
| Warning | `#FBBF24` |
| Danger | `#F87171` |

### Text opacity scale (text on dark)
- **Primary text:** `#FFFFFF`
- **Body text:** `rgba(255,255,255,0.62)`
- **Muted / captions:** `rgba(255,255,255,0.45)`
- **Disabled / faint:** `rgba(255,255,255,0.30)`

---

## 2. Background System

Layered, never flat. Compose in this order (back → front):

1. **Base:** `#000820` solid.
2. **Mesh gradient:** soft teal/cyan radial blooms at low opacity (`.mesh-bg`). Max 2–3 blooms, ≤ 14% opacity.
3. **Grid texture:** 60px teal grid lines at 6% opacity (`.hero-grid`), fading to transparent at edges.
4. **Noise:** very subtle film grain (`.noise-overlay`, ~3% opacity) to kill banding.
5. **Section glow:** a single radial teal glow behind hero / focal sections.

Rules:
- No harsh full-bleed gradients. No rainbow gradients. No more than one focal glow per viewport.
- Dividers between sections use `.section-divider` (1px teal gradient, transparent ends).

---

## 3. Typography

**Families:** `Space Grotesk` for display/headings, `Inter` for body/UI. Both loaded in `index.html`.

| Role | Font | Size (desktop) | Weight | Tracking |
|------|------|----------------|--------|----------|
| Display / H1 | Space Grotesk | `3.25–3.75rem` | 800 | tight (`-0.02em`) |
| H2 (section) | Space Grotesk | `2.25rem` | 700 | tight |
| H3 (card title) | Inter | `1.125rem` | 600 | normal |
| Body large | Inter | `1.0625rem` | 400 | normal, `leading-relaxed` |
| Body | Inter | `0.9375rem` | 400 | normal |
| Caption / meta | Inter | `0.75rem` | 500 | normal |
| Eyebrow / pill | Inter | `0.6875rem` | 700 | `uppercase`, `tracking-widest` |

Rules:
- Headings use `text-balance`. Hero supporting copy capped at `max-w-xl`.
- Gradient text (`.text-gradient-teal`) only on brand words, never whole paragraphs.
- Mobile H1 steps down to `2.25–2.5rem`.

---

## 4. Spacing & Layout

- **Scale (rem):** 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6 — use Tailwind steps `1,2,3,4,6,8,12,16,24`.
- **Container:** `max-w-7xl mx-auto px-4 sm:px-6 lg:px-8`.
- **Section vertical rhythm:** `py-20` mobile, `py-24` desktop. Hero `min-h-screen` with `pt-20`.
- **Card grids:** `gap-5` (tight) or `gap-6` (marketing). Always `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3/4`.
- **Cards in a row must be equal height** (`h-full` + flex column, CTA pinned bottom).

---

## 5. Border Radius

| Element | Radius |
|---------|--------|
| Buttons / inputs / pills | `9999px` (full) for actions, `0.75rem` for inputs |
| Cards | `1rem` (`rounded-2xl`) |
| Large feature panels / mockups | `1.5rem` (`rounded-3xl`) |
| Icon tiles | `0.75rem` (`rounded-xl`) |
| Base token | `--radius: 0.75rem` |

---

## 6. Shadows & Glow

- **Card rest:** `0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 24px rgba(0,0,0,0.25)`.
- **Card hover:** lift `-translate-y-1` + `0 16px 40px rgba(0,0,0,0.35)` + teal edge glow `0 0 0 1px rgba(0,175,193,0.35)`.
- **Focal glow:** `0 0 60px rgba(0,175,193,0.12)`.
- **Primary button glow:** `0 8px 24px rgba(0,175,193,0.25)`.
- Never use pure-black drop shadows on text. No neon over-glow.

---

## 7. Buttons

| Variant | Style |
|---------|-------|
| **Primary** | teal→dark-teal gradient `linear-gradient(135deg,#00AFC1,#008EA3)`, navy text, `rounded-full`, `font-bold`, glow on hover, `scale-[1.03]` on hover, `scale-95` on tap |
| **Secondary** | transparent, `1px solid rgba(0,175,193,0.4)`, teal text, hover `bg-teal/10` |
| **Ghost** | no border, teal text, hover `bg-teal/8` |
| **WhatsApp** | `rgba(34,197,94,*)` green outline → soft green fill on hover, message icon |
| **Danger** | red/`#F87171` outline → soft red fill (admin destructive only) |

Sizes: `px-6 py-3.5` (lg), `px-5 py-2.5` (md), `px-4 py-2` (sm). Min touch target 44px on mobile.

---

## 8. Cards

Unified variants (see `.card-premium` utility). Every card shares: `rounded-2xl`, glass surface, 1px hairline border, consistent padding (`p-6`), hover lift + teal edge.

| Variant | Surface | Notes |
|---------|---------|-------|
| **Marketing / service** | `rgba(255,255,255,0.04)` + hairline | icon tile, title, desc, mini-list, CTA pinned bottom, hover glow |
| **Tool card** | same | category badge top-right, logo/icon, name, CTA |
| **Pricing** | glass; popular = teal gradient surface + animated border | tier eyebrow, price, feature list, CTA |
| **Dashboard stat** | `rgba(255,255,255,0.03)` | label, big number, delta, small icon tile |
| **Dashboard action** | glass-teal | icon, title, arrow, hover lift |
| **Login card** | `glass-card-teal` + strong shadow | centered, `max-w-md` |
| **Portfolio** | glass; gradient preview header | category badge, title, subtitle |
| **Testimonial** | glass | quote, stars, avatar + name + role |
| **Admin table card** | `rgba(255,255,255,0.03)` flatter, minimal hover | density over flair |

Icon treatment: lucide-react, inside a rounded-xl tile tinted with the category color at ~18% bg / 40% border.

---

## 9. Inputs & Forms

- Field: `rounded-xl`, bg `rgba(255,255,255,0.05)`, border `1px solid rgba(0,175,193,0.2)`.
- Focus: border → `#00AFC1`, ring `0 0 0 3px rgba(0,175,193,0.15)`, no default browser outline.
- Leading icon at `left-3`, muted; password reveal at `right-3`.
- Always a visible `<label>` (not placeholder-only). Error text `#F87171` below field.
- Disabled: `opacity-50`, `cursor-not-allowed`.

---

## 10. Dashboard Surfaces

- **Sidebar:** `#000820` with hairline right border `rgba(0,175,193,0.12)`; logo top; nav items `rounded-xl`, active = teal bg `rgba(0,175,193,0.12)` + teal text + left accent; collapses to icon rail < `lg`, drawer on mobile.
- **Topbar:** sticky, `rgba(0,8,32,0.9)` + blur, page title left, user/actions right.
- **Content:** `#000820` base, cards as above. Generous `p-6 lg:p-8`.
- **Admin** prioritizes density & speed: flatter cards, minimal animation, clear tables, obvious status badges.
- **Client** can be slightly more expressive (subtle page transitions, stat reveals).

---

## 11. Animation

Engine: Framer Motion where available; CSS `.reveal` (IntersectionObserver) as the proven fallback already in the codebase.

| Pattern | Spec |
|---------|------|
| Page fade-in | opacity 0→1, y 8→0, 0.4s `easeOut` |
| Hero text reveal | y 24→0, opacity, 0.6s, slight stagger |
| Staggered cards | 0.05–0.08s stagger, y 20→0 |
| Hover lift | `-translate-y-1`, 0.2s |
| Button hover/tap | scale 1.03 / 0.95, 0.15s |
| Floating hero cards | `float` 3.5s ease-in-out infinite, varied delays |
| Pricing popular | animated gradient border / soft pulse glow |
| Mobile menu | height/opacity, 0.25s |
| Accordion | radix height, 0.2s |
| Modal | scale 0.96→1 + fade, 0.2s |

Rules:
- Subtle and premium. No bounce, no spin, no excess parallax.
- **Honor `prefers-reduced-motion`** — disable transforms/transitions (`.reveal`, `float`, etc.).
- Dashboard animation is minimal and practical. Keep 60fps; animate transform/opacity only.

---

## 12. Mobile Rules

- Breakpoints: 360 / 390 / 768 / 1024 / 1440.
- Navbar collapses to a polished drawer < `lg`; logo never wraps.
- Hero stacks; right-side visual hidden < `lg` (no overflow).
- Card grids → single column < `sm`; CTAs stack full-width.
- Tables scroll horizontally inside a rounded container, or become stacked cards.
- Floating WhatsApp button: bottom-right, above content, `safe-area` aware, never covering primary CTAs.
- Min font 14px body on mobile; min touch target 44×44.

---

## 13. Accessibility

- Contrast ≥ 4.5:1 for body text, ≥ 3:1 for large text. Teal `#00AFC1` on navy passes for large/bold; use white for small text.
- Visible focus ring on every interactive element (`:focus-visible` teal outline).
- All icon-only buttons need `aria-label`. All inputs need associated `<label>`.
- Full keyboard navigation; logical tab order; escape closes menus/modals.
- Respect `prefers-reduced-motion`.
- Decorative elements `aria-hidden` / `pointer-events-none`.

---

## 14. Logo Usage

- Source of truth: `frontend/src/components/GenZDigitalStoreLogo.jsx` (inline vector — crisp at any size, no raster).
- **Icon mark** (`variant="icon"`): squircle tile + monogram, for favicon, collapsed sidebar, compact spaces.
- **Full horizontal** (default): icon + "Gen Z Digital Store" wordmark, for navbar, login, footer.
- Standalone files: `public/logo-genz-icon.svg`, `public/logo-genz-digital-store.svg`.
- Never place the logo inside a white box. Never use the raster PNG in UI. Keep clear space ≥ icon height around it.

---

_Last updated as part of the 2026 premium UI upgrade._
