# Dockerfile for Enfyra Backend
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package.json yarn.lock ./

# Install dependencies
RUN yarn install --frozen-lockfile

# Copy source code
COPY . .

# Build application
RUN yarn build

# Expose port
EXPOSE 1105

# Start command
CMD ["node", "dist/src/main.js"]