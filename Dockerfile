FROM mcr.microsoft.com/playwright:v1.56.1-noble
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fontconfig && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
RUN cp fonts/*.ttf /usr/share/fonts/ && fc-cache -f
ENV CHROME_PATH=""
CMD ["node", "engine.mjs"]
