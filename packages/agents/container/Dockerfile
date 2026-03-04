FROM docker.io/cloudflare/sandbox:0.7.11
RUN apt-get update && apt-get install -y jq && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code
ENV COMMAND_TIMEOUT_MS=600000
RUN git config --system user.name "SDLC Agent" && \
    git config --system user.email "agent@llmops.build"
RUN mkdir -p /root/.claude && \
    echo '{"includeCoAuthoredBy": false}' > /root/.claude/settings.json
EXPOSE 3000
