// == ARGUS AGENT PROJECT ==
/*
 * argus-netlock --port <P> -- <command> [args...]
 *
 * Runs a command whose network goes only through Argus's egress proxy: an extension
 * server with `network: proxy` (and everything it starts, Claude Code's shell included).
 *
 *  - Landlock (ABI >= 4): a TCP connect is allowed only to port P. Landlock rules name a
 *    port, not an address: any host on P stays reachable; P is the proxy's random port,
 *    so the private network, the metadata service and Argus's own ports are not.
 *  - seccomp: no UDP or raw sockets (Landlock does not govern them), and no io_uring
 *    (which can open sockets around the filter).
 *
 * Stacked under `landlock-run`'s filesystem rules. On anything it cannot enforce it exits
 * 125 and never runs the command unconfined.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

#define FAIL 125

#if defined(__x86_64__)
#define ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define ARCH AUDIT_ARCH_AARCH64
#else
#error "argus-netlock: x86_64 and aarch64 only"
#endif

#ifndef __NR_io_uring_setup
#define __NR_io_uring_setup 425
#endif

/*
 * Landlock's ABI, spelled out: older kernel headers (Debian 12's 6.1, which builds the
 * image) lack the network part, which a 6.7+ kernel enforces. The values are the kernel's
 * stable UAPI (include/uapi/linux/landlock.h); the syscall numbers are the same on both
 * architectures.
 */
#ifndef SYS_landlock_create_ruleset
#define SYS_landlock_create_ruleset 444
#endif
#ifndef SYS_landlock_add_rule
#define SYS_landlock_add_rule 445
#endif
#ifndef SYS_landlock_restrict_self
#define SYS_landlock_restrict_self 446
#endif
#define NETLOCK_CREATE_RULESET_VERSION (1U << 0)
#define NETLOCK_RULE_NET_PORT 2
#define NETLOCK_ACCESS_NET_CONNECT_TCP (1ULL << 1)
struct netlock_ruleset_attr {
  unsigned long long handled_access_fs;
  unsigned long long handled_access_net;
};
struct netlock_net_port_attr {
  unsigned long long allowed_access;
  unsigned long long port;
} __attribute__((packed));

static int fail(const char *what) {
  fprintf(stderr, "argus-netlock: %s: %s\n", what, strerror(errno));
  return FAIL;
}

static int lock_tcp(long port) {
  int abi = (int)syscall(SYS_landlock_create_ruleset, NULL, 0, NETLOCK_CREATE_RULESET_VERSION);
  if (abi < 4) {
    fprintf(stderr, "argus-netlock: this kernel's Landlock cannot govern TCP (ABI %d, 4 needed)\n", abi);
    return FAIL;
  }
  struct netlock_ruleset_attr ruleset = {.handled_access_fs = 0, .handled_access_net = NETLOCK_ACCESS_NET_CONNECT_TCP};
  int fd = (int)syscall(SYS_landlock_create_ruleset, &ruleset, sizeof ruleset, 0);
  if (fd < 0) return fail("landlock_create_ruleset");
  struct netlock_net_port_attr rule = {.allowed_access = NETLOCK_ACCESS_NET_CONNECT_TCP, .port = (unsigned long long)port};
  if (syscall(SYS_landlock_add_rule, fd, NETLOCK_RULE_NET_PORT, &rule, 0) != 0) return fail("landlock_add_rule");
  if (syscall(SYS_landlock_restrict_self, fd, 0) != 0) return fail("landlock_restrict_self");
  close(fd);
  return 0;
}

static int filter_sockets(void) {
  struct sock_filter program[] = {
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, ARCH, 1, 0),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_setup, 0, 1),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 0, 8),
      // socket(domain, type, protocol): the domain's low word.
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_PACKET, 5, 0),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_INET, 1, 0),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_INET6, 0, 4),
      // An IP socket: the type without its flags must be a stream.
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
      BPF_STMT(BPF_ALU | BPF_AND | BPF_K, 0xf),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SOCK_STREAM, 1, 0),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog prog = {.len = (unsigned short)(sizeof program / sizeof program[0]), .filter = program};
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return fail("no_new_privs");
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog) != 0) return fail("seccomp");
  return 0;
}

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "--probe") == 0) {
    // Whether it can enforce, in a child, so the caller's process stays as it was.
    long abi = syscall(SYS_landlock_create_ruleset, NULL, 0, NETLOCK_CREATE_RULESET_VERSION);
    printf("landlock-abi %ld\n", abi);
    return abi >= 4 ? 0 : FAIL;
  }
  if (argc < 5 || strcmp(argv[1], "--port") != 0 || strcmp(argv[3], "--") != 0) {
    fprintf(stderr, "usage: argus-netlock --port <port> -- <command> [args...]\n");
    return FAIL;
  }
  char *end = NULL;
  long port = strtol(argv[2], &end, 10);
  if (end == argv[2] || *end != '\0' || port < 1 || port > 65535) {
    fprintf(stderr, "argus-netlock: not a port: %s\n", argv[2]);
    return FAIL;
  }
  int status = filter_sockets();
  if (status != 0) return status;
  status = lock_tcp(port);
  if (status != 0) return status;
  execvp(argv[4], &argv[4]);
  return fail(argv[4]);
}
