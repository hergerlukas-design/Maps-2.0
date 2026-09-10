# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build
#
# Die VITE_*-Werte werden zur Build-Zeit in das Bundle eingebacken und müssen
# daher als Build-Argumente kommen, nicht als Laufzeit-Umgebungsvariablen.
# Die Server-Keys (Tankerkönig, GoingElectric, VAPID) sind bewusst NICHT hier:
# sie werden zur Laufzeit gesetzt und landen so nie im Image.
# ---------------------------------------------------------------------------
FROM node:22-slim AS build

WORKDIR /app

ARG VITE_MAPBOX_TOKEN=""
ARG VITE_MAPBOX_STYLE=""
ARG VITE_SUPABASE_URL=""
# Beide Schreibweisen: der neuere `sb_publishable_…`-Schlüssel ist zu
# bevorzugen, der ältere anon-JWT bleibt als Rückfall gültig.
ARG VITE_SUPABASE_PUBLISHABLE_KEY=""
ARG VITE_SUPABASE_ANON_KEY=""
ARG VITE_GEOCODING_COUNTRIES=""

ENV VITE_MAPBOX_TOKEN=$VITE_MAPBOX_TOKEN \
    VITE_MAPBOX_STYLE=$VITE_MAPBOX_STYLE \
    VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY \
    VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY \
    VITE_GEOCODING_COUNTRIES=$VITE_GEOCODING_COUNTRIES

# Erst die Manifeste kopieren, damit der npm-Layer nur bei Abhängigkeits-
# änderungen neu gebaut wird.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build && npm run build:server

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server

# Nicht als root laufen; das node-Image bringt den Nutzer bereits mit.
USER node

EXPOSE 8080

# Fly prüft /api/health; hier zusätzlich für lokale Container-Läufe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist-server/server/index.js"]
