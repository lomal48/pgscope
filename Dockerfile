# pgscope server: one binary with the web UI embedded.
#   docker build -t pgscope:latest .
# Air-gapped hosts: build on a connected machine, then move the image with
#   docker save pgscope:latest | gzip > pgscope.tar.gz   and   docker load -i pgscope.tar.gz

FROM node:22-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /src/web/dist web/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/pgscope .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates && adduser -D -H -u 10001 pgscope
COPY --from=build /out/pgscope /usr/local/bin/pgscope
USER pgscope
EXPOSE 8080
ENTRYPOINT ["pgscope"]
