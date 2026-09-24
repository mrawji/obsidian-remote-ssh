# The E2E suite's environment, as an image.
#
# Why this exists
# ---------------
# The E2E harness takes over the machine it runs on: `launchObsidian` kills
# any running Obsidian and `registerVault` rewrites the real
# `~/.config/obsidian/obsidian.json` so the scaffold vault is the only open
# one. That is fine on a disposable CI runner and unacceptable on anyone's
# desktop — which left the suite runnable in exactly one place, and made
# "reproduce the failure locally" impossible.
#
# Everything the suite needs is therefore in here: Node and the browser
# libraries (from the Playwright base), a real Obsidian, an X server, and the
# Go toolchain the daemon is built with. Nothing is taken from the host but
# the source tree.
#
# The Playwright base is pinned to the version in `plugin/package.json`.
# Playwright refuses to drive a browser bundle it did not ship with, so these
# two move together or not at all.
ARG PLAYWRIGHT_VERSION=v1.63.0-noble
FROM mcr.microsoft.com/playwright:${PLAYWRIGHT_VERSION}

# Pinned deliberately. Obsidian is the application under test, so "whatever
# is current" would make a red run ambiguous between our change and theirs.
# Matches the version `.github/workflows/e2e.yml` caches.
ARG OBSIDIAN_VERSION=1.8.9
ARG GO_VERSION=1.26.0
ARG TARGETARCH

# Obsidian ships a per-architecture AppImage, and this image is built for
# whatever the host is — amd64 on CI, arm64 on an Apple-silicon laptop.
# Extracted rather than run: an AppImage needs FUSE, which a container does
# not have, and `--appimage-extract` sidesteps it exactly as CI does.
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) asset="Obsidian-${OBSIDIAN_VERSION}.AppImage" ;; \
      arm64) asset="Obsidian-${OBSIDIAN_VERSION}-arm64.AppImage" ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    mkdir -p /opt/obsidian; \
    cd /opt/obsidian; \
    curl -fL -o Obsidian.AppImage \
      "https://github.com/obsidianmd/obsidian-releases/releases/download/v${OBSIDIAN_VERSION}/${asset}"; \
    # `-f` already fails on 4xx/5xx so a "Not Found" body cannot be saved as
    # the binary — the mistake that poisoned the CI cache once. This asserts
    # what actually landed, by magic bytes rather than with `file`, which the
    # Playwright base does not ship: `\x7fELF` at offset 0, and AppImage type
    # 2's `AI\x02` at offset 8.
    magic="$(head -c 11 Obsidian.AppImage | od -An -tx1 | tr -d ' \n')"; \
    case "${magic}" in \
      7f454c46*) ;; \
      *) echo "downloaded file is not an ELF binary (magic ${magic})" >&2; exit 1 ;; \
    esac; \
    case "${magic}" in \
      *414902) ;; \
      *) echo "downloaded file is not an AppImage type 2 (magic ${magic})" >&2; exit 1 ;; \
    esac; \
    chmod +x Obsidian.AppImage; \
    # The AppImage's self-extracting runtime links against the unversioned
    # `libz.so`, which only the -dev package ships; the base image has just
    # `libz.so.1`. A symlink is cheaper than pulling in a toolchain package
    # for one extraction, and leaving it costs nothing.
    ln -sf "$(ls /usr/lib/*/libz.so.1 | head -1)" /usr/lib/libz.so; \
    ./Obsidian.AppImage --appimage-extract > /dev/null; \
    rm Obsidian.AppImage; \
    test -x /opt/obsidian/squashfs-root/obsidian

# The daemon (`server/`) is cross-compiled by `npm run build:server`, and the
# RPC-transport specs refuse to scaffold a vault without its binary. Without
# a toolchain in here the suite would still need a Go install on the host,
# which is the dependency this image exists to remove.
RUN set -eux; \
    curl -fL -o /tmp/go.tgz \
      "https://go.dev/dl/go${GO_VERSION}.linux-${TARGETARCH}.tar.gz"; \
    tar -C /usr/local -xzf /tmp/go.tgz; \
    rm /tmp/go.tgz; \
    /usr/local/go/bin/go version

# The reconnect spec simulates "the server went away" by stopping the sshd
# container, so the suite needs to be able to do that from in here. Only the
# client: the daemon is the host's, reached through the socket the compose
# service mounts.
#
# That socket is root-equivalent control of the host's Docker, which is why
# it is granted to this image and nowhere else, and why the compose service
# that mounts it is behind a profile rather than part of the environment.
ARG DOCKER_CLI_VERSION=27.5.1
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) arch=x86_64 ;; \
      arm64) arch=aarch64 ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fL -o /tmp/docker.tgz \
      "https://download.docker.com/linux/static/stable/${arch}/docker-${DOCKER_CLI_VERSION}.tgz"; \
    tar -C /tmp -xzf /tmp/docker.tgz docker/docker; \
    mv /tmp/docker/docker /usr/local/bin/docker; \
    rm -rf /tmp/docker.tgz /tmp/docker; \
    docker --version

ENV PATH="/usr/local/go/bin:${PATH}" \
    OBSIDIAN_PATH=/opt/obsidian/squashfs-root/obsidian \
    DISPLAY=:99

WORKDIR /work/plugin

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["npx", "playwright", "test", "--config", "e2e/playwright.config.ts"]
