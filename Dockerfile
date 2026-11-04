# twilio.iron-wing-dispatching.com — runs behind the kelevo containerized edge
# on the shared `edge` Docker network. Modernized from node:10 → node:22, and
# the real listen port is 3001 (index.js: process.env.PORT || 3001).
FROM node:22-slim

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3001
CMD ["npm", "start"]
