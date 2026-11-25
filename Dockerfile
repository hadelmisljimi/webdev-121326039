# Base Node.js 22 image / Базов образ Node.js 22
FROM node:22-alpine

# Application working directory / Работна директория на приложението
WORKDIR /app

# Install production dependencies first for layer caching
# Инсталиране на зависимостите за продукция с кеширане на слоевете
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source code / Копиране на изходния код
COPY . .

# Default application port / Стандартен порт на приложението
ENV PORT=3000
EXPOSE 3000

# Start HTTP server / Стартиране на HTTP сървъра
CMD ["node", "server.js"]