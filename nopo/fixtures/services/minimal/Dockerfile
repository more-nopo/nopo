# syntax=docker/dockerfile:1
FROM base

# Simple marker file to verify build
RUN echo "FIXTURE_MINIMAL_BUILD_SUCCESS" > /app/build-marker.txt

CMD ["cat", "/app/build-marker.txt"]
