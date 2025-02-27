FROM node:22.14.0-alpine

WORKDIR /app

COPY package*.json /app/

RUN npm ci

EXPOSE 3000

COPY . .

CMD [ "npm", "start" ]