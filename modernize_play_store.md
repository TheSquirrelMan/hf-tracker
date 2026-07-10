# HF Tracker → Play Store Roadmap

## Phase 1: Feature Complete (current)
Iron out all features and bugs in vanilla JS before touching infrastructure.  
Core is stable — a few known edge cases remain (see audit notes in commits).

## Phase 2: Auth & Multi-tenancy
Currently: single hardcoded Firebase path `/hft/{SECRET}/state/`.  
For public release, each user needs their own data.

- **Add Firebase Auth** (email/password + Google sign-in)
- **Scope data** under `/users/{uid}/state/` instead of `/hft/{SECRET}/state/`
- **Migration**: existing user data auto-imports on first auth

## Phase 3: PWA-ify
Play Store requires a PWA wrapper (TWA = Trusted Web Activity).

- `manifest.json` — app name, icons, theme color, display: standalone
- **Service worker** — cache shell + critical assets for offline
- **App icons** — 192px, 512px, maskable variants
- **Splash screen** — from manifest background_color
- Test offline: should show cached UI even without network

## Phase 4: TWA Wrap → Play Store

- **Bubblewrap** CLI: generates signed APK/AAB from your Netlify URL + manifest
- **Play Console** developer account ($25 one-time)
- **Required**: privacy policy page (host on Netlify), app listing, screenshots
- **Digital Asset Links** file on Netlify to prove domain ownership
- Submit for review, iterate on rejections

## Phase 5: Code Modernization (parallel, post-auth)

- **TypeScript** — catch typos, document types (bill, phase, state shapes)
- **Module split** — `render.js`, `calc.js`, `state.js`, `sync.js`
- **Firestore** — optional, better querying for analytics. Realtime DB is fine for current scale.
- **Testing** — unit tests for `calcRoadmap()`, `toMonthlyAmt()`, `getDailyBills()`

---

## Decision Points

| Question | Recommendation |
|---|---|
| Auth provider | Email + Google (Firebase Auth, free tier) |
| Keep Netlify hosting? | Yes — PWA + TWA wraps the web app, no backend needed |
| Replace Firebase DB? | Not yet — Firestore later if query needs grow |
| Rewrite vs refactor? | Refactor incrementally. The app works. |
| Monorepo? | No — single project is fine for one dev |
