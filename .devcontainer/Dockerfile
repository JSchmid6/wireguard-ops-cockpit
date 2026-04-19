FROM mcr.microsoft.com/devcontainers/javascript-node:1-20-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        jq \
        python3 \
        python3-pip \
        ripgrep \
        tmux \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @bradygaster/squad-cli
RUN python3 -m pip install semgrep
