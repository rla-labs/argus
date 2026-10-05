# == ARGUS AGENT PROJECT ==
# A fresh "VPS" for scripts/test-native-vps.sh: Ubuntu 24.04, systemd as PID 1, Node 22.
# Nothing of Argus Agent is in it; the installer brings everything.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus curl git ca-certificates xz-utils tzdata sudo \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /lib/systemd/system/multi-user.target.wants/* /etc/systemd/system/*.wants/* \
          /lib/systemd/system/sockets.target.wants/*udev* /lib/systemd/system/sysinit.target.wants/systemd-tmpfiles-setup*
RUN curl -fsSL https://nodejs.org/dist/v22.21.1/node-v22.21.1-linux-x64.tar.xz \
    | tar -xJ -C /usr/local --strip-components=1 && node --version && corepack --version
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
