# Minimal sshd container for plugin integration tests.
#
# Provides a `tester` user with a known UID, an empty `vault/` home
# subdir for the test to write into, and pubkey-only auth. The
# authorized_keys is bind-mounted by docker-compose so we can rotate
# the key pair without rebuilding the image. `StrictModes no` lets
# sshd accept the bind-mounted key file regardless of host UID/GID
# permissions — fine for a throwaway test container, never for prod.

FROM ubuntu:26.04

# The index fetch is retried because Ubuntu's mirrors are occasionally caught
# mid-sync and serve a Packages.gz whose size disagrees with the Release file
# they served a moment earlier:
#
#   E: Failed to fetch .../Packages.gz  File has unexpected size
#      (642310 != 642308). Mirror sync in progress?
#
# apt treats that as fatal, the image build fails, and an E2E shard goes red
# for a reason that has nothing to do with the change under test — twice in
# one day, most recently on #577. The lists are wiped between attempts
# because a half-fetched index is exactly what we are retrying past. The
# final `apt-get update` is not redundant: it is what turns three exhausted
# attempts into a build failure with apt's own message, rather than an
# install step failing later with something less legible.
RUN for attempt in 1 2 3; do \
      apt-get update && break; \
      echo "apt-get update failed (attempt ${attempt}/3); retrying after 5s"; \
      rm -rf /var/lib/apt/lists/*; \
      sleep 5; \
    done; \
    apt-get update \
 && apt-get install -y --no-install-recommends openssh-server iproute2 \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /var/run/sshd \
 # Ubuntu 24.04+ ships with a pre-created `ubuntu` user at UID 1000;
 # remove it so the well-known `tester` UID stays available. Older
 # bases (22.04) don't have this user — `|| true` keeps the build
 # green if dependabot ever pulls us back.
 && (userdel -r ubuntu 2>/dev/null || true) \
 && useradd -m -s /bin/bash -u 1000 tester \
 && mkdir -p /home/tester/.ssh /home/tester/vault \
 && chown -R tester:tester /home/tester \
 && chmod 700 /home/tester/.ssh \
 && sed -i 's/#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
 && sed -i 's/#\?PubkeyAuthentication.*/PubkeyAuthentication yes/'   /etc/ssh/sshd_config \
 && echo 'StrictModes no' >> /etc/ssh/sshd_config

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 22

# Entrypoint normalises bind-mount ownership; the CMD is the actual
# sshd. `-D` keeps sshd in the foreground; `-e` sends logs to stderr
# so `docker logs` shows them.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["/usr/sbin/sshd", "-D", "-e"]
