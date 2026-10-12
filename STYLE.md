# Hydra dashboard style

This file defines the visual style of the dashboard (`packages/web`). It turns section 10 of the spec
(`docs/superpowers/specs/2026-10-10-hydra-browsers-design.md`) into exact tokens and component rules,
so that all frontend changes look the same.

- The spec is the source of truth. If this file and the spec do not agree, follow the spec and tell
  the user.
- "(spec)" marks a value or rule that comes from the spec. This file defines the other values.
- The Neko client in the live view is third-party code. This file does not apply to it.

## 1. Rules

1. Use only the tokens of section 2 and the components of section 5. Do not write a color, font size,
   radius, shadow, z-index, or duration directly in a component.
2. Each color token has a light value and a dark value. The theme follows `prefers-color-scheme`
   (spec). There is no manual theme switch.
3. Text uses the accessible variant of a system color (spec). Text contrast meets WCAG AA in both
   themes (spec). The contrast test of section 8 must pass.
4. All controls work with the keyboard. The focus ring is always visible (spec).
5. Use Tailwind CSS v4 utilities that map to the tokens (section 9), Radix primitives for interactive
   parts, and Tabler icons (spec).
6. Animations use CSS transitions only (spec). Obey `prefers-reduced-motion`.
7. Write our own components. Do not copy code from `ridvanonal/macos-react`. Credit the project in the
   README (spec).
8. If a change needs a new value, add the token to this file in the same change, and tell the user.

## 2. Tokens

### 2.1 System colors

Apple system colors, each with a light and a dark value (spec). Use the default value for fills,
dots, and icons. Use the accessible value for text (spec).

| Token | Light | Dark | Accessible light | Accessible dark |
|---|---|---|---|---|
| `--os-red` | `#FF3B30` | `#FF453A` | `#D70015` | `#FF6961` |
| `--os-orange` | `#FF9500` | `#FF9F0A` | `#C93400` | `#FFB340` |
| `--os-yellow` | `#FFCC00` | `#FFD60A` | `#B25000` | `#FFD426` |
| `--os-green` | `#34C759` | `#30D158` | `#217F38` | `#30DB5B` |
| `--os-mint` | `#00C7BE` | `#63E6E2` | `#0C7C76` | `#66D4CF` |
| `--os-teal` | `#30B0C7` | `#40C8E0` | `#00788D` | `#5DE6FF` |
| `--os-cyan` | `#32ADE6` | `#64D2FF` | `#0071A4` | `#70D7FF` |
| `--os-blue` | `#007AFF` | `#0A84FF` | `#0040DD` | `#409CFF` |
| `--os-indigo` | `#5856D6` | `#5E5CE6` | `#3634A3` | `#7D7AFF` |
| `--os-purple` | `#AF52DE` | `#BF5AF2` | `#8944AB` | `#DA8FFF` |
| `--os-pink` | `#FF2D55` | `#FF375F` | `#D30F45` | `#FF6482` |
| `--os-brown` | `#A2845E` | `#AC8E68` | `#7F6545` | `#B59469` |
| `--os-gray` | `#8E8E93` | `#8E8E93` | `#6C6C70` | `#AEAEB2` |

- The accessible token of each color is `--os-<color>-accessible`, for example `--os-red-accessible`.
- The accessible light values of green, mint, and teal are darker than the Apple values (`#248A3D`,
  `#0C817B`, `#008299`). The Apple values fail WCAG AA on the translucent surfaces.
- Secondary text (captions, column headers, hints) uses `--os-gray-accessible`. Section 2.4 gives
  its size.

### 2.2 Surface tokens

| Token | Light | Dark | Use |
|---|---|---|---|
| `--os-surface` (spec) | `#FFFFFF` | `#1E1E1E` | Window material, content pane, inputs, menus |
| `--os-foreground` (spec) | `#1D1D1F` | `#F5F5F7` | Primary text and icons |
| `--os-tone` (spec) | `rgb(0 0 0 / 5%)` | `rgb(255 255 255 / 8%)` | Fill of controls, chips, row hover |
| `--os-tone-strong` | `rgb(0 0 0 / 10%)` | `rgb(255 255 255 / 14%)` | Hover and pressed fill of controls |
| `--os-black` (spec) | `#000000` | `#000000` | Background around the live view |
| `--os-gray-1` (spec `--os-gray-*`) | `#8E8E93` | `#8E8E93` | Icons that are not active |
| `--os-gray-2` | `#AEAEB2` | `#636366` | Borders of checkboxes and radios |
| `--os-gray-3` | `#C7C7CC` | `#48484A` | Track of a switch that is off (dark) |
| `--os-gray-4` | `#D1D1D6` | `#3A3A3C` | Track of a switch that is off (light) |
| `--os-gray-5` | `#E5E5EA` | `#2C2C2E` | Background of table headers in the dark theme |
| `--os-gray-6` | `#F2F2F7` | `#1C1C1E` | Background of code blocks, and of table headers in the light theme |
| `--os-accent` (spec) | `#007AFF` | `#0A84FF` | Focus ring, selection marks, switch on |
| `--os-accent-fill` | `#0062D6` | `#0062D6` | Primary buttons, selected sidebar item |
| `--os-danger-fill` | `#D70015` | `#D70015` | Destructive buttons |
| `--os-accent-fill-hover` | `color-mix(in oklab, var(--os-accent-fill) 92%, var(--os-black))` | `color-mix(in oklab, var(--os-accent-fill) 92%, var(--os-black))` | Hover fill of primary buttons |
| `--os-danger-fill-hover` | `color-mix(in oklab, var(--os-danger-fill) 92%, var(--os-black))` | `color-mix(in oklab, var(--os-danger-fill) 92%, var(--os-black))` | Hover fill of destructive buttons |
| `--os-on-fill` | `#FFFFFF` | `#FFFFFF` | Text and icons on the two fill tokens |
| `--os-separator` | `rgb(0 0 0 / 10%)` | `rgb(255 255 255 / 12%)` | Hairlines and input borders |
| `--os-overlay` | `rgb(0 0 0 / 20%)` | `rgb(0 0 0 / 40%)` | Backdrop behind a sheet |
| `--os-segment-selected` | `#FFFFFF` | `#636366` | Selected segment of a segmented control |

- White text on `--os-accent` gets only 4.0:1 (light) and 3.6:1 (dark). Thus filled controls use
  `--os-accent-fill` (5.65:1), and never `--os-accent`.
- White text on `--os-red` gets only 3.55:1. Thus destructive buttons use `--os-danger-fill` (5.38:1).

### 2.3 Wallpaper and traffic lights

| Token | Light | Dark |
|---|---|---|
| `--os-wallpaper` | `linear-gradient(135deg, #DCE6F5 0%, #F1E4EC 100%)` | `linear-gradient(135deg, #1A2233 0%, #2B1F30 100%)` |
| `--os-traffic-red` | `#FF5F57` | same |
| `--os-traffic-red-border` | `#E2463F` | same |
| `--os-traffic-yellow` | `#FEBC2E` | same |
| `--os-traffic-yellow-border` | `#E1A116` | same |
| `--os-traffic-green` | `#28C840` | same |
| `--os-traffic-green-border` | `#14AE29` | same |

The contrast test of section 8 uses the two colors of each wallpaper gradient. If you change the
wallpaper, run the test again.

### 2.4 Typography

| Token | Value |
|---|---|
| `--os-font-sans` (spec) | `-apple-system, BlinkMacSystemFont, "Inter", sans-serif` |
| `--os-font-mono` | `ui-monospace, Menlo, Consolas, monospace` |
| `--os-text-xs` | 11px, line height 14px: captions, status bar, section headers |
| `--os-text-sm` | 12px, line height 16px: chips, menus, monospace commands |
| `--os-text-base` | 13px, line height 18px: body text, controls, tables |
| `--os-text-lg` | 15px, line height 20px: session name in the toolbar |
| `--os-text-xl` | 20px, line height 25px: title of the login panel |

- Weights: 400 (regular), 500 (medium: controls), 600 (semibold: headers and titles).
- Do not bundle font files. Do not include SF Pro (spec).

#### Size of secondary text

The color does not set the size. Gray text (`--os-gray-accessible`) and red text
(`--os-red-accessible`) use `--os-text-xs` or `--os-text-base`, as the table shows.

| Kind | Size | Examples |
|---|---|---|
| Caption: a short label or a value, not a sentence | `--os-text-xs` | Section headers, column headers, menu labels, the status bar, the state in the toolbar, an email under a name, "No sessions" in the sidebar |
| Message: a sentence that the user reads | `--os-text-base` | Sheet descriptions, hints and errors under a field, form errors, notices such as "Only the owner and admins can change the settings.", a status next to a button such as "Saved" |

- If the text is a sentence, or if it is near a control or body text, use `--os-text-base`.
- A hint and the error that replaces it have the same size, so that the layout does not move.
- Do not use `--os-text-xs` for a hint, an error, or a description. In a sheet, it looks smaller
  than the description and the labels around it.

### 2.5 Shape and depth

| Token | Value |
|---|---|
| `--os-radius-window` (spec) | 12px (Tailwind `rounded-xl`): window, sheets (bottom corners), login panel |
| `--os-radius-menu` | 8px: menus, banners |
| `--os-radius-control` | 6px: buttons, inputs, segmented controls, chips, sidebar items |
| `--os-radius-checkbox` | 4px |
| `--os-shadow-window` (spec) | Light: `0 0 0 1px rgb(0 0 0 / 8%), 0 24px 64px -8px rgb(0 0 0 / 28%), inset 0 1px 0 0 rgb(255 255 255 / 60%)`. Dark: `0 0 0 1px rgb(0 0 0 / 60%), 0 24px 64px -8px rgb(0 0 0 / 60%), inset 0 1px 0 0 rgb(255 255 255 / 10%)` |
| `--os-shadow-menu` | Light: `0 0 0 1px rgb(0 0 0 / 8%), 0 8px 24px rgb(0 0 0 / 16%)`. Dark: `0 0 0 1px rgb(255 255 255 / 10%), 0 8px 24px rgb(0 0 0 / 50%)` |
| `--os-shadow-control` | Light: `0 0 0 0.5px rgb(0 0 0 / 8%), 0 1px 2px rgb(0 0 0 / 15%)`. Dark: `0 1px 2px rgb(0 0 0 / 40%)` |

The window shadow has a 1 px outline, a large soft drop shadow, and an inner 1 px highlight (spec).

### 2.6 Materials

| Material | Classes |
|---|---|
| Window (spec) | `bg-os-surface/70 backdrop-blur-2xl shadow-os-window rounded-xl` |
| Sidebar (spec: translucent) | `bg-os-surface/50 backdrop-blur-2xl`, a hairline `--os-separator` on the right |
| Content pane | `bg-os-surface` (opaque, so that the text contrast does not depend on the wallpaper) |
| Menus and sheets | `bg-os-surface` with `shadow-os-menu` |

### 2.7 Motion and layers

| Token | Value |
|---|---|
| `--os-duration-fast` | 120ms: hover, press, switch thumb |
| `--os-duration-base` | 200ms: sheet in, menu in |
| `--os-duration-out` | 150ms: sheet out, menu out (with `--os-ease-in`) |
| `--os-ease-out` | `cubic-bezier(0.2, 0, 0, 1)`: elements that come in |
| `--os-ease-in` | `cubic-bezier(0.4, 0, 1, 1)`: elements that go out (use 150ms) |
| `--os-z-overlay` | 40 |
| `--os-z-sheet` | 50 |
| `--os-z-menu` | 60 |

If `prefers-reduced-motion: reduce` is set, use only opacity transitions, without movement.

### 2.8 Sizes

| Token | Value |
|---|---|
| `--os-window-inset` | 24px between the window and the edges of the viewport |
| `--os-sidebar-width` (spec) | 240px |
| `--os-toolbar-height` | 52px |
| `--os-control-height` | 28px |
| `--os-control-height-sm` | 24px (the minimum target size) |
| `--os-row-height` | 28px: sidebar items, menu items have 24px |
| `--os-table-row-height` | 32px |
| `--os-statusbar-height` | 28px |
| Minimum viewport width | 1024px (spec) |

Spacing uses the Tailwind scale (base 4 px). Use only multiples of 4 px, and 2 px or 6 px inside small
controls.

## 3. Focus and accessibility

- Focus ring (spec: accent): `outline: 2px solid var(--os-accent); outline-offset: 2px;` on
  `:focus-visible`. Never remove it.
- Contrast of the ring: 4.02:1 on `#FFFFFF`, 4.57:1 on `#1E1E1E`.
- Use Radix primitives for dialogs, menus, segmented controls, switches, checkboxes, and radios. They
  give keyboard support and focus traps.
- `Esc` closes a sheet or a menu. Focus goes back to the control that opened it.
- Each icon-only button has an `aria-label`. Decorative icons have `aria-hidden="true"`.
- A status dot alone must not carry the meaning. Each status dot has a visually hidden text with the
  state.

## 4. Layout (spec section 10)

- The app is one window over the wallpaper (spec). The window fills the viewport minus
  `--os-window-inset` on each side.
- The sidebar has the full height of the window. The traffic lights are at its top left, 20px from the
  left edge, and in the vertical center of the first 52px.
- The main column has the toolbar (52px, hairline at the bottom) and the content pane under it.
- The login screen and the change-password screen show one centered panel (360px wide) with the window
  material, and no sidebar (spec).

## 5. Components (`packages/web/src/components/os/`)

| Component | Rules |
|---|---|
| `AppWindow` | Window material (section 2.6). Contains `Sidebar` and the main column. |
| `TrafficLights` | Three 12px circles (spec), gap 8px, colors of section 2.3 with a 0.5px border. Decorative only: `aria-hidden="true"`, no click actions. |
| `Sidebar` | 240px (spec), sidebar material. Sections "My sessions", "Shared with me", and "Admin" (admins only). Section headers: `--os-text-xs`, weight 600, `--os-gray-accessible`. User menu at the bottom (spec). |
| Sidebar item | Height 28px, radius 6px, padding 0 8px, gap 8px: status dot, name (truncated), agent icon (`IconRobot`, 14px) when `activeAgentCount` is 1 or more (spec). Hover: `--os-tone`. Selected: `--os-accent-fill` background, `--os-on-fill` text. |
| New-session button | 24px icon button with `IconPlus` in the header of "My sessions", `aria-label="New session"`. |
| `Toolbar` | 52px. Left: session name (`--os-text-lg`, 600) and state (`--os-text-xs`, `--os-gray-accessible`). Center: `SegmentedControl` with the views. Right: **Start** or **Stop**, **Restart**, and a "more" menu (`IconDots`) with **Delete** (spec). |
| `SegmentedControl` | Radix ToggleGroup (single). Height 28px, radius 6px, track `--os-tone`, selected segment `--os-segment-selected` with `shadow-os-control`, text `--os-text-base` weight 500. Arrow keys move between segments. Shows only the views that the user has rights for. |
| `Button` | Height 28px (small: 24px), radius 6px, padding 0 12px, `--os-text-base` weight 500. Variants: `default` (`--os-tone`, hover `--os-tone-strong`), `primary` (`--os-accent-fill`), `destructive` (`--os-danger-fill`), `ghost` (transparent, hover `--os-tone`). Text on fills is `--os-on-fill`. Hover on a fill: `--os-accent-fill-hover` or `--os-danger-fill-hover` (section 2.2, which mixes the fill 92% with `--os-black`). Disabled: opacity 40%. |
| `Switch` | Radix Switch. Track 36x20px, radius full. Off: `--os-gray-4` (light) or `--os-gray-3` (dark). On: `--os-accent`. White thumb with `shadow-os-control`. |
| Checkbox, radio | Radix. 16px. Checkbox radius 4px, radio radius full. Border 1px `--os-gray-2`. Checked: `--os-accent-fill` with a white mark. |
| Text input | Height 28px, radius 6px, `bg-os-surface`, border 1px `--os-separator`, padding 0 8px, `--os-text-base`. Label above it: `--os-text-base`, `--os-foreground`, gap 4px. Hint under it: `--os-text-base`, `--os-gray-accessible`. Error under it (it replaces the hint): `--os-text-base`, `--os-red-accessible`. See "Size of secondary text" (section 2.4). |
| `ChipInput` | Allowlist editor (spec). Chips: height 22px, radius 6px, `--os-tone`, `--os-text-sm`, a remove button with `IconX` 12px and `aria-label="Remove <host>"`. `Enter` or `,` adds a chip. `Backspace` in an empty input removes the last chip. |
| `Table` | Rows 32px, `--os-text-base`. Header: `--os-text-xs`, weight 600, `--os-gray-accessible`, background `--os-gray-6` in the light theme and `--os-gray-5` in the dark theme (`bg-os-gray-6 dark:bg-os-gray-5`). On `--os-gray-5`, the light header text is only 4.16:1. Hairline between rows. Row hover: `--os-tone`. Numbers align right. |
| `StatusDot` | 8px circle. Fill: `--os-green` (`running`), `--os-yellow` (`starting`, `stopping`), `--os-gray` (`stopped`), `--os-red` (`error`) (spec). Inner 1px border with the accessible variant of the same color, for 3:1 contrast. Visually hidden text with the state. |
| `Banner` | Radius 8px, padding 8px 12px, 16px icon on the left, `--os-text-base`. Text: the accessible variant of its color. Background: `color-mix(in srgb, <color> 12%, var(--os-surface))`. Variants: `info` (blue), `warning` (orange). |
| `Sheet` | Radix Dialog. It moves down from the bottom of the toolbar (spec). Width 480px (560px for the token sheet). Square top corners, 12px bottom corners. Backdrop `--os-overlay`. In: `translateY(-8px)` to 0 and opacity 0 to 1, `--os-duration-base`, `--os-ease-out`. Out: 150ms, `--os-ease-in`. Footer: buttons on the right; **Cancel** (`default`), then the action (`primary` or `destructive`). |
| Menu | Radix DropdownMenu. Radius 8px, padding 4px, items 24px high, `--os-text-sm`, menu material. A destructive item uses `--os-red-accessible`. |
| Live view | The iframe keeps the aspect ratio of the session screen and is centered on `--os-black` (spec). Banners are above the iframe. The status bar (28px, `--os-text-xs`, `--os-gray-accessible`) is under it: connected agents, the last tool call in `--os-font-mono` (for example `browser_click · ok · 230 ms`), and the full-screen button (`IconMaximize`) on the right (spec). |
| Code block | For the token commands: `--os-gray-6` background, radius 6px, `--os-font-mono` `--os-text-sm`, a copy button (`IconCopy`, `aria-label="Copy"`). |
| `CountdownRing` | 16px circle with a 2px stroke: track `--os-tone-strong`, progress `--os-accent`, from the top, clockwise. It shows the part of a TOTP period that is left. `role="img"` and a label, for example "12 seconds left". |
| Secret value (credential sheet) | A hidden value shows dots in `--os-font-mono` `--os-text-sm`. On the right: the eye button (`IconEye` or `IconEyeOff`, `aria-label` "Show password", "Hide password", "Show code", "Hide code") and the copy button (`IconCopy`, `aria-label` "Copy password" or "Copy code"). A label above the value: `--os-text-xs`, weight 600, `--os-gray-accessible`. |

Banner variants for the spec texts:

| Text (spec) | Variant |
|---|---|
| "Agent active" | `info` |
| "More than one agent is connected" | `warning` |
| "Allowlist permits all domains" | `warning` |
| "Restart required" | `info` |

## 6. Icons

- Tabler icons (`@tabler/icons-react`) (spec), stroke width 1.75.
- Size 16px in controls, 18px in the toolbar and the sidebar, 14px for the agent icon.
- Icons use `currentColor`.

## 7. UI text

Use these texts exactly (spec):

- Sidebar: "My sessions", "Shared with me", "Admin", "Users", "All sessions".
- Views: "Live", "Tokens", "Vault", "Sharing", "Activity", "Settings".
- Buttons: "Start", "Stop", "Restart", "Delete", "Retry start", "Revoke", "Remove", "Load older", "New credential",
  "Edit", "Done", "Advanced".
- Sheets: "New session", "New token", "Create user", "New credential", "Edit credential".
- Credential fields: "Name", "Website", "Login", "Password", "Two-factor secret", "Two-factor code".
- Banners and notices: "Agent active", "More than one agent is connected", "Allowlist permits all
  domains", "Restart required".
- Login error: "Invalid email or password".
- Token sheet commands: `claude mcp add --transport http <name> <HYDRA_PUBLIC_URL>/s/<sid>/mcp --header "Authorization: Bearer <token>"`, and the JSON `mcpServers` config.

## 8. Contrast test

`packages/web/src/theme/contrast.test.ts` computes the WCAG contrast ratio of these pairs, in both
themes. The test fails if one ratio is below the limit.

| Foreground | Backgrounds | Limit |
|---|---|---|
| `--os-foreground`, each `--os-<color>-accessible` | `--os-surface`; `--os-surface` at 50% and at 70% over each wallpaper color | 4.5:1 |
| `--os-on-fill` | `--os-accent-fill`, `--os-danger-fill` | 4.5:1 |
| `--os-gray-accessible` (table header text) | `--os-gray-6` (light theme), `--os-gray-5` (dark theme) | 4.5:1 |
| Accessible variant (dot border) | `--os-surface` | 3:1 |
| `--os-accent` (focus ring) | `--os-surface` | 3:1 |

The test reads the token values from `theme/tokens.css`, so that the test and the CSS cannot differ.

## 9. Tailwind CSS v4 mapping

`packages/web/src/theme/tokens.css` defines the CSS variables (light values in `:root`, dark values in
`@media (prefers-color-scheme: dark) { :root { … } }`). It then maps them with `@theme inline`:

```css
@theme inline {
  --color-os-surface: var(--os-surface);
  --color-os-foreground: var(--os-foreground);
  --color-os-tone: var(--os-tone);
  --color-os-tone-strong: var(--os-tone-strong);
  --color-os-black: var(--os-black);
  --color-os-gray-1: var(--os-gray-1);
  --color-os-gray-2: var(--os-gray-2);
  --color-os-gray-3: var(--os-gray-3);
  --color-os-gray-4: var(--os-gray-4);
  --color-os-gray-5: var(--os-gray-5);
  --color-os-gray-6: var(--os-gray-6);
  --color-os-accent: var(--os-accent);
  --color-os-accent-fill: var(--os-accent-fill);
  --color-os-danger-fill: var(--os-danger-fill);
  --color-os-accent-fill-hover: var(--os-accent-fill-hover);
  --color-os-danger-fill-hover: var(--os-danger-fill-hover);
  --color-os-on-fill: var(--os-on-fill);
  --color-os-separator: var(--os-separator);
  --color-os-overlay: var(--os-overlay);
  --color-os-segment-selected: var(--os-segment-selected);
  /* One pair for each system color: red, orange, yellow, green, mint, teal, cyan, blue, indigo,
     purple, pink, brown, gray. */
  --color-os-red: var(--os-red);
  --color-os-red-accessible: var(--os-red-accessible);
  /* … the same two lines for each other system color … */
  --font-sans: var(--os-font-sans);
  --font-mono: var(--os-font-mono);
  --text-os-xs: 11px;
  --text-os-xs--line-height: 14px;
  --text-os-sm: 12px;
  --text-os-sm--line-height: 16px;
  --text-os-base: 13px;
  --text-os-base--line-height: 18px;
  --text-os-lg: 15px;
  --text-os-lg--line-height: 20px;
  --text-os-xl: 20px;
  --text-os-xl--line-height: 25px;
  --radius-os-menu: var(--os-radius-menu);
  --radius-os-control: var(--os-radius-control);
  --radius-os-checkbox: var(--os-radius-checkbox);
  --shadow-os-window: var(--os-shadow-window);
  --shadow-os-menu: var(--os-shadow-menu);
  --shadow-os-control: var(--os-shadow-control);
  --ease-os-out: var(--os-ease-out);
  --ease-os-in: var(--os-ease-in);
}
```

- Thus the spec classes work: `bg-os-surface/70`, `backdrop-blur-2xl`, `rounded-xl` (spec).
- Text color utilities: `text-os-foreground`, `text-os-red-accessible`, `text-os-gray-accessible`.
- Write the full list in `tokens.css`. The comment lines above only shorten this file.
