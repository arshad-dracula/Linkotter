# Relay server (derper) built from the open-source Tailscale tree.
FROM golang:1-alpine AS build
ARG TAILSCALE_VERSION=v1.104.7
ENV GOTOOLCHAIN=auto
RUN go install tailscale.com/cmd/derper@${TAILSCALE_VERSION}

FROM alpine:3.23
RUN apk add --no-cache ca-certificates
COPY --from=build /go/bin/derper /usr/local/bin/derper
ENTRYPOINT ["/usr/local/bin/derper"]
