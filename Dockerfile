# Use Node.js 18 LTS with Alpine for smaller image size
FROM node:18-alpine

# Install system dependencies required for native modules
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    musl-dev \
    giflib-dev \
    pixman-dev \
    pangomm-dev \
    libjpeg-turbo-dev \
    freetype-dev \
    graphicsmagick \
    ghostscript \
    poppler-utils \
    vips-dev \
    pkgconfig \
    libc6-compat

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (including dev dependencies for build)
RUN npm ci && npm cache clean --force

# Copy TypeScript configuration
COPY tsconfig.json ./
COPY tsconfig.build.json ./

# Copy source code
COPY src/ ./src/

# Install TypeScript and build dependencies
RUN npm install -g typescript
RUN npm install --save-dev typescript @types/node

# Build the application
RUN npm run build

# Copy PDF templates and other necessary files
COPY proof.pdf ./
COPY eng.traineddata ./
COPY files/statement.pdf ./files/
COPY files/helvetica-light.ttf ./files/
COPY files/fonts/ ./files/fonts/
COPY files/tymebank/input.pdf ./files/tymebank/
COPY files/tymebank/input2.pdf ./files/tymebank/
COPY files/capitec/input.pdf ./files/capitec/
COPY files/capitec/input2.pdf ./files/capitec/

# Normalize font filename casing to match runtime expectations
RUN if [ -f "./files/fonts/arial-Bold.ttf" ] && [ ! -f "./files/fonts/Arial-Bold.ttf" ]; then \
      mv ./files/fonts/arial-Bold.ttf ./files/fonts/Arial-Bold.ttf; \
    fi

# Remove dev dependencies to reduce image size
RUN npm prune --production

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001

# Create necessary directories and set permissions
RUN mkdir -p /app/files /app/images
RUN chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Expose port (Cloud Run will set PORT environment variable)
EXPOSE 8080

# Set environment variables
ENV NODE_ENV=production
ENV PORT=8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8080/api/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })" || exit 1

# Start the application
CMD ["node", "build/server.js"]
