FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=400"
COPY package.json ./
COPY src ./src
EXPOSE 10000
USER node
CMD ["node", "--expose-gc", "src/index.js"]
