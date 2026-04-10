FROM golang:1.25-alpine AS builder
WORKDIR /app
COPY . .
RUN go mod tidy
RUN CGO_ENABLED=0 GOOS=linux go build -o /bin/server ./cmd/server

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=builder /bin/server /bin/server
EXPOSE 8080
CMD ["/bin/server"]
