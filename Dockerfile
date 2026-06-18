FROM ghcr.io/puppeteer/puppeteer
ARG APP_PORT
WORKDIR /app
COPY package.json ./
RUN npm i;
USER root
ENV PUPPETEER_CACHE_DIR=/root/.cache/puppeteer
RUN npx puppeteer browsers install chrome
COPY . .
ENV APP_PORT=$APP_PORT
EXPOSE $APP_PORT
CMD ["node", "index.js"]
