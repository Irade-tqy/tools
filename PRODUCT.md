# Tools

<!-- impeccable:product-schema 1 -->

## Platform

web

## Product Purpose

A browser toolbox for shared Markdown documents and DeepSeek conversations.

## Capabilities and Constraints

- Preserve existing chat queue, streaming, authentication, relay, and legacy clipboard APIs.
- `/chat/` contains login, conversation, and settings states. `/` redirects there.
- `/paste/?name=…` opens a named document. `/paste/` creates a public document.
- Documents support public editing, public reading with password protected editing, and password protected reading and editing. Permissions must be enforced by the server.
- Keep the current Vite/TypeScript static deployment and GitHub Pages compatibility.
- Use the supplied Chinese PRD and six reference images. The user delegates conflict resolution.
- Avoid Playwright and extensive automated interaction testing. Supply a manual adversarial checklist.

## Brand Commitments

IRADE TOOLS is the product wordmark supplied in the references. The editor and image upload follow the existing shsfdy2sq implementation without its specialized extensions.

## Evidence on Hand

The reference files were supplied through LAN Drop on 2026-10-15. Their local working copies are in `/tmp/tools-design-references/`.
