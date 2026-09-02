# Minimal base Dockerfile for nopo fixtures
# This provides a base image that fixture services can extend
ARG BASE_FROM=alpine:3.19
FROM ${BASE_FROM} AS development

RUN apk add --no-cache bash

WORKDIR /app

FROM development AS production
