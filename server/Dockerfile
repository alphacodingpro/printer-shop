FROM node:22-slim
# LibreOffice converts Word/PowerPoint/Excel uploads to PDF. Build with
#   --build-arg WITH_LIBREOFFICE=false
# for a much smaller image that accepts only PDF and photos.
ARG WITH_LIBREOFFICE=true
RUN if [ "$WITH_LIBREOFFICE" = "true" ]; then \
      apt-get update && apt-get install -y --no-install-recommends libreoffice-writer libreoffice-calc libreoffice-impress fonts-dejavu fonts-noto-core \
      && rm -rf /var/lib/apt/lists/*; \
    fi
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production STORAGE_DIR=/data/storage
RUN mkdir -p /data/storage && chown -R node:node /data /app
USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
