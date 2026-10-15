---
name: Tools
description: Shared Markdown writing and a focused conversational workspace.
colors:
  blue: "#0c5bff"
  blue-soft: "#e9f4ff"
  ink: "#252b35"
  muted: "#657083"
  line: "#e0e4ea"
  ground: "#f3f4f6"
  hover: "#eef1f5"
  white: "white"
  blue-hover: "#004de5"
  blue-disabled: "#9bbaff"
  secondary: "#9ba4b2"
  secondary-hover: "#7a8697"
  error: "#bf3344"
typography:
  display:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif'
    fontSize: "clamp(56px, 7.2vw, 84px)"
    fontWeight: 900
    lineHeight: 0.92
    letterSpacing: "-.04em"
  headline:
    fontSize: "clamp(25px, 4vw, 32px)"
    fontWeight: 550
    letterSpacing: "-.035em"
  title:
    fontSize: "23px"
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif'
    fontSize: "15px"
  label:
    fontSize: "13px"
  editor:
    fontFamily: '"SFMono-Regular", Consolas, "Noto Sans Mono CJK SC", monospace'
    fontSize: "15px"
    lineHeight: 1.7
rounded:
  inline-code: "4px"
  chip: "6px"
  control: "8px"
  settings-row: "12px"
  user-message: "13px"
  menu: "14px"
  dialog: "18px"
  settings-panel: "22px"
  composer: "30px"
  password: "32px"
  circle: "50%"
spacing:
  compact: "4px"
  control: "8px"
  field: "12px"
  regular: "16px"
  panel: "24px"
  roomy: "32px"
components:
  button:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "9px 16px"
    typography: "{typography.label}"
  button-primary:
    backgroundColor: "{colors.blue}"
    textColor: "{colors.white}"
    rounded: "{rounded.control}"
    padding: "9px 16px"
    typography: "{typography.label}"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
    padding: "10px"
    width: "40px"
    height: "40px"
  icon-button-hover:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.ink}"
  action-primary:
    backgroundColor: "{colors.blue}"
    textColor: "{colors.white}"
    rounded: "{rounded.circle}"
    padding: "15px"
    width: "52px"
    height: "52px"
  action-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.white}"
    rounded: "{rounded.circle}"
    padding: "15px"
    width: "52px"
    height: "52px"
  password-input:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.password}"
    padding: "0 51px 0 22px"
    height: "52px"
    width: "100%"
  chip:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.muted}"
    rounded: "{rounded.chip}"
    padding: "2px 7px"
  settings-row:
    rounded: "{rounded.settings-row}"
    padding: "18px"
  navigation:
    height: "76px"
    padding: "14px 23px"
---

# Design System: Tools

## Overview

**Creative North Star: "Quiet shared writing surface"**

Saturated blue actions sit on white work areas, with pale gray gates and slate secondary text. The supplied references establish this direction. The interface gives most space to writing, previewing, and conversation; toolbar icons remain visually light at rest.

This document records the current implementation from `src/styles.css`, `index.html`, `src/lib/icons.ts`, `src/views/paste.ts`, and `src/lib/markdown.ts`, interpreted with `PRODUCT.md` and `.impeccable/surfaces/src-main-ts.md`. Values are source-derived, not sampled from a rendered browser. Browser rendering was unavailable through CUA, and Playwright was prohibited. A separate source reviewer reported five recovery issues resolved; that report is not visual approval. No screenshots or visual acceptance are claimed here.

**Key Characteristics:**
- Saturated blue actions with white and pale gray surfaces.
- Transparent, borderless resting icon controls using Font Awesome SVGs.
- Ordinary controls use gently rounded corners; circles and larger containers retain their own geometry.
- Narrow conversation reading width and a viewport-filling Markdown workspace.

## Colors

### Primary

Blue identifies primary actions, links, editor caret, focus rings, and the existing wordmark. Soft blue backs user messages. Darker blue is the emphasized circular action hover state; the disabled blue keeps the same action hierarchy with less contrast.

### Neutral

Ink carries primary text. Muted slate carries helper text, metadata, and ordinary icon controls. White is the work surface; ground gray backs gates, chips, and secondary text buttons. Line gray separates panes and fields. Hover gray appears behind ordinary icons only during interaction. The secondary circular action uses a stronger slate fill with its own darker hover state.

Error red belongs to inline validation and message errors. It is a status color, not another brand accent. The stylesheet also contains contextual connection dots and toast colors; those remain local component values rather than a new palette scale. Sidecar tonal ramps are synthesized preview metadata, not colors used by the application. The frontmatter records the implemented colors.

## Typography

The system UI stack in the frontmatter handles Latin and Chinese interface text. The source editor uses the monospace stack. There is no external display-font dependency.

The login wordmark uses the display role with italic styling, tight tracking, and two staggered lines. At widths up to 700px, its size becomes `clamp(54px, 16vw, 78px)`. The blocked-document heading uses its own italic treatment, with a weight of 850 and size `clamp(45px, 7vw, 74px)`.

The headline role belongs to the chat empty state; the title role describes the settings heading. Body text starts at the root size. Assistant responses use 16px on desktop and 15px at the mobile breakpoint. Markdown line height is 1.85, with heading sizes relative to the surrounding content. Labels and form help generally use 13px, while status text and metadata use 11px. These observed sizes do not form a fixed mathematical scale.

## Layout

Conversation content is centered, capped at 780px, with a separate composer capped at 790px and fixed to the bottom. The chat header is 76px high. Settings use a centered panel capped at 760px. Login content caps at 460px; the blocked-document gate caps at 440px.

The document workspace occupies `100dvh`, with a 10px outer inset. Its toolbar has a minimum height of 45px. The editor and preview share the remaining height; the initial editor width is 50%. A 1px separator has a wider transparent pointer area. Edit-only and preview-only modes hide the unused pane and separator. The source editor and preview scroll within their own panes.

At 1000px, the toolbar wraps and individual icon widths decrease. At 700px, the chat header becomes 64px, document inset becomes 5px, formatting tools scroll horizontally, and document actions move to a second row. Preview padding and editor type sizes decrease, while the editor status bar is hidden. The source pane also establishes `container: editor-pane / inline-size`; `@container editor-pane (max-width: 300px)` hides its status bar when resizing makes the pane narrow, including on desktop. The mobile CSS keeps split mode available; it does not force stacked panes. The composer includes safe-area bottom padding.

Spacing is contextual. The frontmatter records repeated steps visible in the implementation, not a claim that every gap follows a uniform grid.

## Elevation & Depth

Most surfaces use white, pale gray, and thin boundaries. Shadows identify the composer, floating composer menu, dialog, and toast. Exact shadow values are in the sidecar and remain sourced from the stylesheet. The dialog also dims the page with a translucent backdrop. Settings and document panes use borders rather than ambient card shadows.

## Shapes

Ordinary buttons, inputs, textareas, and selects inherit the control radius. The user explicitly permits circles and larger panel radii. The circular primary and secondary actions, pill password fields, capsule composer, rounded settings panel, dialog, and menu are established exceptions. Small metadata chips and inline code retain their more compact corners.

Icon buttons have no resting border or fill unless emphasized. Field and panel borders remain appropriate. User messages use a softly rounded blue-tinted bubble; assistant content sits directly on the white surface.

## Components

### Buttons and icons

Font Awesome solid definitions are imported explicitly and rendered as inline SVGs. Ordinary icons use muted color with a transparent background and no border. Their typical target is 40px square; chat-header targets are 42px and formatting targets are 30px. Hover adds the gray surface and stronger text color. Pressing an enabled icon scales it to .94. Disabled icons are muted and partially transparent.

Primary circular actions use blue and white; secondary circular actions use slate and white. Their usual diameter is 52px, reducing to 46px on mobile. Composer and settings actions use 42px. Text buttons use the ground surface, with a blue variant for primary submissions. The text-button source does not define a separate hover fill.

Focusable buttons, links, summaries, selects, and tabindex targets receive a blue 2px outline with 3px offset. Inputs and textareas use a lighter blue outline with 2px offset. Reduced-motion CSS collapses transitions. These are source-defined behaviors, not a completed accessibility audit.

### Fields and gates

Password fields are white pills with a line-gray stroke and an inset reveal icon. Error messages appear inline. General dialog and configuration fields use ordinary control corners. The document-name field is a compact, borderless toolbar field with muted text and a red invalid state; it differs intentionally from form fields.

Login and blocked-document gates center a blue italic heading, gray supporting copy, and password controls over a pale gray surface. Documents with public reading and password-protected editing open directly in preview. Their gray permission icon requests an editing unlock without changing permissions, and the gate provides a “仅查看” return action. This is the intentionally resolved usability exception to disabling all controls. Private documents stay gated, with link copy available. When permissions change, private-document auto-unlock retries a saved password once per document revision and password combination.

### Navigation and settings containers

Chat navigation pairs the compact wordmark link with four icon actions. The section label disappears at the mobile breakpoint. Settings use a large bordered panel with heading rows and compact bordered setting groups. The source's administrative card wrapper adds vertical spacing without a separate border or shadow.

### Chips and conversation

Metadata chips use small muted text over ground gray with compact padding. User messages have blue-tinted surfaces; assistant text remains open. Message actions use smaller borderless icon buttons. Error and status copy remain near their associated message or composer.

### Markdown workspace

The toolbar groups formatting actions separately from document name, permission, share, and copy actions. The separator grows blue during hover or dragging. Source content uses muted slate line numbers and a pale active line; preview content supports prose, code blocks, tables, images, and math with overflow rules. Math is emitted as native MathML through KaTeX with trust disabled; no KaTeX stylesheet or font assets are loaded. The preview's code and image corners use the ordinary control radius. No raster assets ship in this frontend replacement.

The insertion dialog uses a white raised surface, a dim backdrop, and right-aligned text actions. Its image upload area has a dashed boundary, pale blue ground, and a stronger drag state. Toasts appear near the bottom center, with a distinct error variant.

## Do's and Don'ts

### Do:
- **Do** preserve the supplied saturated blue, white work areas, pale gray gates, and muted slate supporting text.
- **Do** keep Font Awesome icon controls transparent and borderless at rest unless the action is emphasized.
- **Do** use the ordinary control radius for regular controls and preserve the established circle, pill, and panel exceptions.
- **Do** retain visible keyboard focus and the reduced-motion treatment when extending these components.
- **Do** distinguish source review from visual acceptance when reporting completion.

### Don't:
- **Don't** turn every icon into a filled or outlined resting button.
- **Don't** flatten the established circular actions and larger panels to the ordinary control radius.
- **Don't** introduce decorative palette roles, font dependencies, or shadows unsupported by the implementation or supplied references.
- **Don't** present component previews, source checks, or generated color ramps as screenshots or browser validation.
