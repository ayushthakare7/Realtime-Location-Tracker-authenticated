FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
COPY server.js ./
EXPOSE 3101
CMD ["npm", "start"]
