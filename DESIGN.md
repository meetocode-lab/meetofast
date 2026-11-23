# Meofast Design System — Blue Aurora

Meofast inherits and extends the **Blue Aurora** visual identity established in `meorora`, tailored for a high-density, desktop-first web API development platform and a calm, trustworthy first-time installation wizard.

---

## 1. Visual Direction & Theme Policy

- **Default Theme:** **Light (`data-theme="light"`)** by explicit product specification, optimized for crisp daytime readability across long API inspection sessions.
- **Theme Switching:** Instant toggle between **Light** (`data-theme="light"`) and **Dark** (`data-theme="dark"`) persisted in `localStorage` (`meofast-theme-preference`) and hydrated prior to first paint to prevent theme flash.
- **Allowed Brand Palette:** Royal/Cobalt Blue, Cyan, Sky Blue, Pure White, and Cool Slate neutrals.
- **Strict Exclusions:** Never use purple, violet, magenta, or pink in brand accents, illustrations, or gradients. No decorative glassmorphism, neon halos, hard neobrutalist shadows, kickers/eyebrows above headings, or emoji/unicode icons.

---

## 2. Design Tokens (`src/styles/tokens.css` & `src/styles/themes.css`)

### Light Theme (`:root`, `[data-theme="light"]` — Default)

| Token | Value | Purpose |
|---|---|---|
| `--color-primary` | `#2563eb` | Primary CTA buttons, active tabs, Send action, selected tree rows |
| `--color-primary-hover` | `#1d4ed8` | Primary interactive hover |
| `--color-primary-active` | `#1e40af` | Primary active press |
| `--color-primary-subtle` | `#eff6ff` | Subtle active row fill, badge background |
| `--color-primary-foreground` | `#ffffff` | Text/icons on primary fill |
| `--color-cyan` | `#22d3ee` | Brand mark secondary facet, subtle accent |
| `--color-sky` | `#7dd3fc` | Brand mark highlight, secondary chart/progress |
| `--color-background` | `#f8fbff` | Application shell canvas |
| `--color-surface` | `#ffffff` | Primary workspace panes, cards, inputs, modals |
| `--color-surface-secondary` | `#eff6ff` | Code pills, segmented tab wells, table headers |
| `--color-surface-hover` | `#f1f7ff` | Row hover, ghost button hover |
| `--color-text` | `#0f172a` | Primary headings, URL inputs, code & body text |
| `--color-text-secondary` | `#475569` | Labels, inactive tabs, metadata |
| `--color-text-muted` | `#64748b` | Placeholders, hints, disabled labels |
| `--color-border` | `#dbeafe` | Hairline pane dividers, card borders |
| `--color-border-strong` | `#bfdbfe` | Input borders, outlined buttons, active dividers |
| `--color-focus-ring` | `#2563eb` | 2px `:focus-visible` accessibility outline |

### Dark Theme (`[data-theme="dark"]`)

| Token | Value | Purpose |
|---|---|---|
| `--color-primary` | `#3b82f6` | Primary CTA & active indicators on dark surfaces |
| `--color-primary-hover` | `#60a5fa` | Hover state |
| `--color-primary-active` | `#2563eb` | Active press |
| `--color-primary-subtle` | `#172e4d` | Selected navigation & tree highlight |
| `--color-background` | `#071426` | Deep navy aurora shell background |
| `--color-surface` | `#0f1f36` | Primary panels, editors, cards, dialogs |
| `--color-surface-secondary` | `#142a46` | Secondary wells, code headers, segmented bars |
| `--color-surface-hover` | `#1b3554` | Interactive hover surface |
| `--color-text` | `#f8fafc` | Primary foreground text |
| `--color-text-secondary` | `#cbd5e1` | Secondary labels |
| `--color-text-muted` | `#94a3b8` | Muted hints & placeholders |
| `--color-border` | `#243b59` | Hairline structural borders |
| `--color-border-strong` | `#365779` | Input & interactive control borders |
| `--color-focus-ring` | `#60a5fa` | Accessible focus outline |

### Semantic Feedback & HTTP Method Tokens

Semantic colors are strictly reserved for operational status and HTTP verb recognition:

- **Success / `GET` / `2xx`:** `--color-success` (`#15803d` light / `#4ade80` dark), `--color-success-subtle`
- **Primary / `POST`:** `--color-primary` (`#2563eb` light / `#3b82f6` dark), `--color-primary-subtle`
- **Warning / `PUT` / `3xx`–`4xx`:** `--color-warning` (`#b45309` light / `#fbbf24` dark), `--color-warning-subtle`
- **Info / `PATCH` / `HEAD`:** `--color-info` (`#0369a1` light / `#38bdf8` dark), `--color-info-subtle`
- **Danger / `DELETE` / `5xx`:** `--color-danger` (`#b91c1c` light / `#f87171` dark), `--color-danger-subtle`

---

## 3. Typography & Numeric Precision

- **UI Sans Font (`--font-family-base`):** `Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`
- **Code & Wire Font (`--font-family-mono`):** `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`
  - Used exclusively for URLs with `{{variables}}`, HTTP headers, JSON/XML request & response bodies, cURL snippets, status codes, byte sizes, and millisecond timings—never as decorative prose labels.
- **Tabular Numerals:** All status codes (`200 OK`), latency timings (`142 ms`), payload sizes (`12.4 KB`), step counters, and audit log timestamps enforce `font-variant-numeric: tabular-nums`.
- **Scale:**
  - `xs` (`0.75rem` / 12px) — Badges, HTTP method tags, table column headers, shortcuts (`Ctrl K`)
  - `sm` (`0.875rem` / 14px) — Dense IDE controls, sidebar tree items, form inputs, key-value editors
  - `base` (`1rem` / 16px) — Wizard body copy, dialog content
  - `lg` (`1.125rem` / 18px) — Section headings
  - `xl` (`1.25rem` / 20px) — Brand header, panel titles
  - `2xl` (`1.5rem` / 24px) — Setup wizard step titles

---

## 4. Layout & Surface Modes

### A. First-Time Installation Wizard (`/setup`)
- **Isolated Clean Shell:** Centered two-column operational frame (`max-width: 64rem`) on `--color-background` with left step-progress rail (Steps 1–7) and right interactive configuration surface (`--color-surface`), plus top bar with Meofast Blue Aurora mark, version pill, and Light/Dark theme switch.
- **Zero Clutter:** No sidebar navigation, no unauthenticated dead links, clear inline error diagnostics, and real-time progress checklist during migration & bootstrap locking.

### B. Main API Workspace (`/`)
- **Desktop-First High-Density Grid:**
  1. **Top Bar (`52px`):** Brand mark, Workspace switcher, Command Palette search trigger (`Ctrl+K`), active Environment selector + Secret vault modal button, Theme toggle, User menu.
  2. **Activity Rail (`56px`) + Collection Explorer (`260px`–`360px`):** Switch between Collections, Environments, History, Team/RBAC, and Admin/Security; hierarchical folder/request tree with search and Import/Export actions.
  3. **Request Workbench (Top/Left Split):** Multi-request tab strip, unified Method + URL + Send/Cancel bar, and segmented tabs (`Params`, `Auth`, `Headers`, `Body`, `Tests`).
  4. **Response Inspector & Console (Bottom/Right Resizable Split):** Status/Time/Size telemetry bar, formatted JSON/Raw/Headers/Cookies/Assertions tabs, and collapsible live Execution Console.

---

## 5. Strict Component Directory Standard

Following `meorora` conventions, every reusable UI primitive lives in its own `kebab-case` directory inside `apps/web/src/components/ui/`:

```text
apps/web/src/components/ui/
├── avatar/
├── badge/
├── button/
├── card/
├── dialog/
├── icon/
├── input/
├── select/
├── skeleton/
├── spinner/
├── switch/
├── tabs/
└── index.ts
```

- Icons are rendered exclusively via `<Icon name="..." />` using clean, uniform-stroke SVG paths (`strokeWidth={1.8}`). Unicode symbols and emojis are banned from UI chrome.
- Browser surfaces (`::selection`, `:focus-visible`, custom scrollbars, `color-scheme`) are explicitly themed from Blue Aurora tokens in both Light and Dark modes.
