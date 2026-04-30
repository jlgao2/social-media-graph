# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Start Vite dev server (hot reload)
npm run build      # Production build → dist/
npm run preview    # Serve the production build locally
```

No test framework is configured.

## Architecture

This is a single-page React app that renders a personal social-network CRM — an interactive force-directed graph of contacts, with a detail panel for managing relationship data.

### Entry points

- `index.html` → `src/main.jsx` → mounts `<SocialGraphCRM />` from `social-graph-crm.jsx`
- All application logic lives in **`social-graph-crm.jsx`** (~930 lines, two components)

### Component structure (`social-graph-crm.jsx`)

**`SocialGraphCRM`** — the entire app:
- Left panel (60 %): D3 force-directed graph rendered into an SVG via `useEffect`/`useRef`. Nodes are people; edges are connections. The simulation uses charge, link-distance, and collision forces.
- Right panel (40 %): Either a network overview or a selected-person detail view with three tabs — Details, Interactions, Connections.
- Toolbar: search/filter, add-person button, import/export JSON.

**`PersonModal`** — add/edit form rendered as a modal overlay.

### Data model

```
people[]      id, name, relationship, email, phone, location,
              birthday, tags, notes, avatar,
              interactions[], followUp

connections[] source (id), target (id), strength
```

### State & persistence

All state is managed with `useState`. On every change the full data object is written to `localStorage` under the key `'socialGraphCRM'`. Import/export uses browser JSON download/upload — there is no backend or remote API.

### Key config objects (top of `social-graph-crm.jsx`)

- `RELATIONSHIP_TYPES` — maps type names to colors and labels (Family, Friend, Colleague, Acquaintance, Mentor)
- `INITIAL_DATA` — fallback seed data used when localStorage is empty

### Data files

- `instagram-contacts-import.json` — pre-built contact dataset; auto-loaded on first run if localStorage is empty (gitignored)
- `contacts/*.vcf` — VCard export(s) for name resolution (gitignored)
- `instagram-*/` and `whatsapp/` — raw social media exports, source material (gitignored)
- `chat.db` — macOS Messages SQLite database, source material (gitignored)

### D3 integration pattern

The graph is initialized in a `useEffect` that depends on the filtered people/connections arrays. When data or filters change the effect tears down the old simulation and rebuilds it. Node drag, zoom/pan, and click events are wired up inside this effect. Avoid splitting the D3 setup across multiple effects — the entire simulation lifecycle should stay in one effect block to prevent stale-closure issues.
