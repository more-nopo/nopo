# syntax=docker/dockerfile:1
FROM base

# Simple marker file to verify build
RUN echo "FIXTURE_DEPENDENT_BUILD_SUCCESS" > /app/build-marker.txt

CMD ["cat", "/app/build-marker.txt"]
