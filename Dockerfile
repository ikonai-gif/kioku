FROM node:20-alpine AS builder
WORKDIR /app

# Install build dependencies for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++ ffmpeg

COPY package*.json ./
RUN npm install --production=false
COPY . .
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
