FROM ubuntu:22.04

ARG DAML_VERSION=3.4.11

RUN apt-get update && apt-get install -y \
    curl \
    openjdk-17-jre-headless \
    socat \
    && rm -rf /var/lib/apt/lists/*

ENV DAML_HOME=/root/.daml
ENV PATH="$DAML_HOME/bin:$PATH"

RUN curl -sSL https://get.daml.com/ | sh -s -- $DAML_VERSION --install-assistant yes

WORKDIR /app

COPY daml.yaml ./
COPY daml/ ./daml/
COPY docker-entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

EXPOSE 6865 7575

ENTRYPOINT ["./entrypoint.sh"]
