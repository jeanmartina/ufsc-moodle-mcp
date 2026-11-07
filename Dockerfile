FROM node:22-alpine

RUN apk add --no-cache \
    poppler-utils \
    tesseract-ocr \
    tesseract-ocr-data-eng \
    tesseract-ocr-data-por

WORKDIR /app

COPY package.json ./
RUN node -e "const fs=require('fs'),p=JSON.parse(fs.readFileSync('package.json','utf8'));delete p.devDependencies;fs.writeFileSync('package.json',JSON.stringify(p,null,2));" \
    && npm install --no-audit --no-fund

COPY dist/ ./dist/
COPY http-server.mjs ./

ENV NODE_ENV=production
ENV PORT=8088
ENV HOST=0.0.0.0

EXPOSE 8088

CMD ["node", "http-server.mjs"]
