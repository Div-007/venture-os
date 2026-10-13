# Frontend route ownership

The connected workspace is the local default. `/` and `/dashboard` land on `/dashboard/live`; the connected shell links only to API-backed pages. It never substitutes browser-local sample data when the API or session is unavailable.

| Public entry | Connected destination |
| --- | --- |
| `/dashboard`, `/tasks`, `/board`, `/channels`, `/messages` | Corresponding `/live` page |
| `/notifications`, `/focus`, `/knowledge`, `/planning`, `/sales`, `/admin` | Corresponding `/live` page |
| `/classes`, `/decisions`, `/timeline`, `/requests` | `/planning/live` |
| `/documents` | `/knowledge/live` |
| `/today`, `/status`, `/ventures` | `/dashboard/live` (venture scope is selected inside the dashboard) |
| `/sign-in`, `/invite` | Corresponding `/live` auth page |

The approved sample-data prototype remains available at `/demo` and `/demo/<page>`. Its sidebar, topbar, and page links stay inside `/demo`; the banner says that changes do not reach the connected workspace. The live pages link to that prototype explicitly. Legacy prototype-only entries (`/ai/chat`, `/finance`, `/help`, `/hr`, `/inventory`, `/logout`, `/operations`, `/purchase`, `/settings`) go to `/unavailable`, which explains the missing live implementation and offers an explicit demo link.

The connected page components still live under their existing `/live` paths. Temporary redirects in `next.config.ts` make the public entries canonical without moving those components; rewrites expose the existing prototype under `/demo` without duplicating it.
