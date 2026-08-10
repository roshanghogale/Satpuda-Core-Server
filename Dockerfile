FROM node:20-alpine AS admin-build
WORKDIR /app/admin
COPY admin/package*.json ./
RUN npm install
COPY admin/ ./
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
COPY --from=admin-build /app/admin/dist ./admin/dist
EXPOSE 3000
CMD ["sh", "-c", "node src/db/migrate.js && node src/db/seed.js && node src/index.js"]
