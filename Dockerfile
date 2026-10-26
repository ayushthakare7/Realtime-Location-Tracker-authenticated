FROM node:22-bookworm-slim
ENV PYTHONUNBUFFERED=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-venv supervisor ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install --omit=dev
COPY mobility-service/package.json ./mobility-service/package.json
RUN cd mobility-service && npm install --omit=dev
COPY rag_service/requirements.txt ./rag_service/requirements.txt
RUN python3 -m venv /opt/reva-venv && /opt/reva-venv/bin/pip install --no-cache-dir --upgrade pip && /opt/reva-venv/bin/pip install --no-cache-dir -r rag_service/requirements.txt
COPY . .

# Build frontend bundles after source files have been copied into the image.
RUN npm install --no-save esbuild && npm run mobile:build && npm run mobile:push-build && npm prune --omit=dev
RUN cp /app/deploy/supervisord.conf /etc/supervisor/conf.d/reva.conf && chmod +x /app/start-services.sh
EXPOSE 10000
CMD ["/app/start-services.sh"]
