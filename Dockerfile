FROM node:22-alpine

WORKDIR /app
COPY DECLARATION.md ./
COPY signatures ./signatures
COPY scripts ./scripts
COPY site ./site

RUN node site/build.js

ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "site/server.js"]
