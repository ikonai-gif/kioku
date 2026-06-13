FROM node:20-alpine AS builder
WORKDIR /app

# Install build dependencies for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++ ffmpeg

COPY package*.json ./
RUN npm install --production=false
COPY . .

# Build-time env vars (VITE_*) — must be declared as ARG and re-exported as
# ENV so that `vite build` sees them. Railway passes its env vars as docker
# build args automatically; without these lines they are invisible to vite.
# Add a new ARG/ENV pair here for every new VITE_* flag.
ARG VITE_UI_V2_CANVAS_ENABLED
ENV VITE_UI_V2_CANVAS_ENABLED=${VITE_UI_V2_CANVAS_ENABLED}

RUN npm run build

FROM node:20-alpine
WORKDIR /app
# ffmpeg + ttf-dejavu (required for drawtext in title cards/subtitles) + fontconfig
# python3 + yt-dlp: social-media metadata extraction for luca_read_url
#   (Instagram/TikTok/YouTube/Twitter return JS shells to plain fetch;
#    yt-dlp pulls caption, uploader, duration from their public APIs.)
RUN apk add --no-cache ffmpeg ttf-dejavu fontconfig python3 py3-pip \
    && pip3 install --break-system-packages --no-cache-dir yt-dlp==2026.3.17
# [LUCA-060] MarkItDown — Office/HTML/EPUB attachment text extraction.
# Optional + non-fatal: if the install fails (e.g. musl wheel issues) the image
# still builds and the summarizer falls back at runtime. Only the extras we use
# are installed to avoid heavy deps (magika/onnxruntime).
RUN pip3 install --break-system-packages --no-cache-dir 'markitdown[docx,xlsx,pptx]' \
    || echo "WARN: markitdown install failed; attachment summarizer will fall back"
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "dist/index.cjs"]
