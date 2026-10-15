# Frontend rewrite

## Preview

- Chat: `http://100.84.128.13:5173/chat/`
- New document: `http://100.84.128.13:5173/paste/`
- Open a document: `/paste/?name=…`
- `/` redirects to `/chat/`. Settings and login stay on the chat page.
- Local development: `npm run dev -- --host 0.0.0.0`
- Static build: `npm run build`. The build emits `chat/index.html` and `paste/index.html` with relative asset paths for GitHub Pages prefixes.

The working directory is `/home/irade/tools`. The six reference PNGs and Chinese PRD are retained in LAN Drop, with working copies under `/tmp/tools-design-references/`.

## Backend scope

The existing shared clipboard, chat, relay, queue, and credential RPC implementations are unchanged. The named document feature adds one migration, `20261015052449_named_pastes.sql`, with isolated tables in the internal `app` schema, a `paste_document` RPC, and a `tools-images` storage bucket. The migration was applied to the configured Supabase project. The website has not been published to GitHub Pages.

Document permissions are checked on the server. Writes carry a revision so a second device cannot silently overwrite a newer document. Passwords are hashed server side; document access tokens expire after 12 hours. The requested local password recall uses localStorage. The older shared feed and its encrypted files remain in their existing tables and APIs; the new named editor does not convert or delete them.

Image upload follows shsfdy2sq: supported raster images up to 5 MB, scaled to at most 3000 pixels on the longer side, converted to WebP. The image dialog supports file selection, paste, drag/drop, external URLs, and alt text. Uploaded image URLs are public, including images inserted in password protected documents; the upload dialog states this before upload.

## Decisions where references and requirements differ

- Ordinary corners use 8px; circular action buttons and large panels use proportional radii, following the user's clarification.
- Public-read/password-write documents open directly in preview. Their gray permission icon requests password unlock instead of changing permissions, so a reader has a usable path to editing. Private documents show the Blocked gate.
- Passwords are remembered after successful verification. An incorrect input does not replace a working saved password.
- Existing conversations without saved branch ids start a new conversation if an older turn is edited. New turns preserve branch ids for edit/regenerate.
- Markdown is sanitized before display. KaTeX produces native MathML, supporting `$…$`, `$$…$$`, `\(…\)`, and `\[…\]`. Specialized shsfdy2sq extensions are omitted.

## Manual adversarial checklist

Use disposable documents and conversations. Two browser profiles or devices are useful for permission and conflict checks.

| Scenario | Action | Expected result |
| --- | --- | --- |
| Basic writing | Open `/paste/`, type Markdown, refresh after saving; open its copied link on another device. | Same named document and content. No extra clipboard title or version text. |
| Names | Try a duplicate name, 15 emoji, 16 emoji, and a long name; blur the field. Rename the same document from two devices. | Invalid text turns red without blocking typing. Invalid/duplicate names revert. Valid names update the URL. Conflicting changes do not overwrite silently. |
| Permissions | Cycle public → password write → private. Set a Unicode password, then return to public and back. Open in a fresh profile. | Password is set once and retained across mode changes. Public-read mode shows preview. Private mode hides content. Copy buttons and formatting follow access. |
| Password recall | Reload with a saved password; then open a different document with another password. | Matching saved credentials unlock automatically. A mismatched password leaves a usable input. SET pre-fills the last saved password and shows its note. |
| Draft recovery | Go offline while editing, then reload and unlock if prompted. Also force the first page request to fail, reconnect, and retry. | Unsaved text is retained locally and offered after unlocking. Recovered protected documents allow password entry. Another device's newer revision is not overwritten. |
| Slow mutations | Throttle the network while renaming or changing permissions. Attempt to type during the request. | Editing is temporarily read only. Pending text is saved or retained locally; no edit disappears. |
| Layout and keyboard | Try desktop and a narrow phone viewport; cycle split/edit/preview. Drag the divider to both ends, and use its Left/Right/Home/End keys. Tab through controls. | No horizontal page overflow. Narrow toolbar can scroll. Status bar hides when narrow. Focus is visible. Pane proportions can reach either end. |
| Images | Select, paste, and drop an image; try a non-image and a file over 5 MB; try upload from a locked document. | Valid images insert as Markdown with a public URL. Invalid files show a recoverable error. Locked uploads are rejected. |
| Login and chat | Log in by typing, by pasting while no input is selected, and from a text/JSON code file. Change send mode in settings. Reload. | Login is remembered. Enter versus Ctrl/⌘+Enter follows settings. Shift+Enter inserts a newline. Settings stay on the chat page. |
| Streaming and failed edits | While a reply streams, type another prompt and press Enter. Then edit an earlier turn while offline or after login expires. | Streaming does not clear the next draft. Failed enqueue restores existing history and keeps the edited prompt. Stop remains usable. |
| Session files | Export a conversation, start a new one, import the export, then try malformed JSON. | Valid history and continuation ids restore. Invalid files leave the current conversation intact. Replacement asks for confirmation. |
| Visual comparison | Compare login, SET, BLOCKED, split editor, conversation, and settings against the six PNGs. | Check spacing, font sizes, colors, icon alignment, and phone layout in a real browser. Report the URL, viewport size, steps, and expected/actual behavior for any mismatch. |

## Checks performed

- TypeScript and production build passed.
- 66 focused unit checks passed across frontend trust boundaries, rendering, sessions, configuration, and API contracts.
- 21 database access checks passed inside a transaction that rolled back all temporary changes.
- Live HTTP checked creation, private read denial, denied unauthorized image upload, allowed authorized image upload, and public image retrieval. Test data was cleaned up.
- Font Awesome declarations in the HTML shell passed; dynamic icon names are checked by TypeScript.
- A source review found five recovery issues; the reviewer scored all five fixes resolved.
- The static design detector flagged muted text contrast, which was darkened. Its other warnings concern the reference's outlined settings rows, required compact status bar, and an offset shadow on a white surface; those are retained intentionally.

No Playwright was used. No browser surface was available through CUA, so rendered appearance, actual focus/touch interactions, and a real chat round from the new UI remain unverified. The Supabase advisor command could not run because the CLI has no linked project; the isolated access checks above ran against the configured database instead.
