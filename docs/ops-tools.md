# Ops tools (ops-broker)
With `OPS_TOOLS=on`, the reasoner CLI can query operational state and fix code into draft PRs. Credentials and the work directory
are never put into the reasoner container; only a separate relay container (`ops-broker`) holds them. The reasoner container can
only request fixed queries through MCP tools.

```
reasoner container --MCP(http, internal network)--> ops-broker     --ssh OPS_SSH_USER--> inventory hosts (within OPS_SSH_ALLOWED_CIDR)
  (no credentials, no shell or shell rejected)      (keys, tokens) --kubectl (read-only SA)--> OPS_K8S_CONTEXTS clusters
                                                                   --read-only mount--> OPS_FS_ROOT
                                                                   --git(https, user token)--> GitHub (pacenote/* branches, draft PRs)
                                                                   --REST(user token, read)--> GitHub (repositories, PR queries)
                                                                   --REST(API token)--> Jira (allowed project queries, issue create/comment)
```

| Tool | What it does | Limits |
| --- | --- | --- |
| `host_list`, `host_check` | Host checks over SSH: `uptime`, `dmesg`, `memory`, `disk`, `top`, `pci_devices`, `failed_units`, `service`, `journal` | Fixed checks with format-validated arguments only. Hosts are named from the host list only, within `OPS_SSH_ALLOWED_CIDR` |
| `k8s_get`, `k8s_describe`, `k8s_logs`, `k8s_events`, `k8s_top` | kubectl queries | Enforced on the cluster side by a read-only SA (`sandbox/k8s/pacenote-ro.yaml`, ClusterRole `view` plus cluster-scoped reads). Secrets are blocked by both RBAC and the broker |
| `fs_list`, `fs_find`, `fs_search`, `fs_read` | Work directory reads | Read-only mount. Excludes `.env`, keys, kubeconfig, `*secret*`, `.git`, `.venv` and similar. Rejects paths outside the root and links pointing outside it. Searches must be scoped to a repository or a path inside one |
| `ws_prepare`, `ws_read`, `ws_search`, `ws_list`, `ws_edit`, `ws_write`, `ws_delete`, `ws_diff`, `ws_create_pr` | Code changes and draft PRs | See "Code changes and PRs" below |
| `gh_repo_search`, `gh_pr_list`, `gh_pr_search`, `gh_pr_view`, `gh_pr_diff` | GitHub repository search, PR list/search, PR details (reviews, CI checks, changed files), diff | Read-only. Only `OPS_GIT_ALLOWED_OWNERS` orgs. A repository name without an org is looked up in the allowed orgs; if there is none, similar repositories are suggested |
| `jira_search`, `jira_issue`, `jira_create_issue`, `jira_add_comment` | Jira JQL search, issue details (description, sub-issues and linked issues, recent comments), issue creation, comments | Only `OPS_JIRA_PROJECTS` projects (JQL is pinned to a project condition). Writes happen only on request, are made as the token owner's account, and are limited to 20 per hour. No status changes |

- Every tool output is returned with secret values in common formats, such as tokens and private keys, masked.
- Jira is accessed only with the broker's API token (`OPS_JIRA_TOKEN`). The broker connects directly, so Jira is not added to the proxy's allowed domains.
- GitHub is queried only with the broker's token (`gh auth token`). The reasoner container cannot reach GitHub and has no token.
  codex's ChatGPT app connectors (`codex_apps`, including the GitHub connector) have a different permission scope and send data
  over a different path, so they are turned off in sandbox runs. (`codex exec --disable apps`)
- Every call is logged by the broker (`docker logs pacenote-sandbox-ops-broker-1`).
- Because it uses credentials, the bot does not start without `REASONER_SANDBOX=docker` and `MENTION_ALLOWED_USERS`.
- To add checks, edit `src/broker/checks.ts` (SSH) or `src/broker/k8s.ts` and rebuild the broker.

## Code changes and PRs

- `ws_prepare(repo)`: finds `origin` from the local repository directory name and, if it is a repository of an allowed org
  (`OPS_GIT_ALLOWED_OWNERS`), creates a workspace on a `pacenote/<date>-<id>` branch from the remote default branch.
  The workspace is a mirror worktree in the broker volume (`ops-work`), so the user's local working tree and changes in progress are not touched.
- Changes are made only with `ws_edit` (exact string replacement), `ws_write` and `ws_delete`. There is no shell and no test run.
  Verification is left to the PR's CI and human review.
- `ws_create_pr`: commits after policy checks, pushes only to `pacenote/*` branches, and creates a draft PR.
  - Rejected: no changes, `.github/workflows/`, `.gitmodules`, secret file paths, secret value formats in the diff, more than 50 files, more than 3000 added lines
  - The commit author is `OPS_GIT_AUTHOR_NAME`, `OPS_GIT_AUTHOR_EMAIL`, or, when they are empty, the user in the global git config (`git config --global`).
    This is separate from this repository's git config. PRs are created as the `gh` login account. Limited to 10 per hour.
- The GitHub token is read with `gh auth token` by the broker jobs (`pnpm sandbox:ops-up`, "Recreate broker" in the app) and passed only as a broker environment variable. The model cannot see it.
  It has the `repo` and `workflow` scopes, so in production a fine-grained PAT limited to the target repositories is recommended instead.
- Workspaces are cleaned up after 24 hours.

Setup: no value of the target environment lives in the code; all of them go into `OPS_*` in the config file (`~/.pacenote/.env`). Each feature is optional, and the broker starts without the tools of any feature left empty.
Files the broker generates, such as the host list and kubeconfig, are also created outside the repository, in `~/.pacenote/ops-broker/`.

| Feature | Settings | If empty |
| --- | --- | --- |
| File reads (`fs_*`) | `OPS_FS_ROOT` | File and PR tools off |
| GitHub queries, PRs (`gh_*`, `ws_*`) | `OPS_GIT_ALLOWED_OWNERS` (+ `gh auth login`, commit author `OPS_GIT_AUTHOR_*`) | GitHub and PR tools off |
| Jira (`jira_*`) | `OPS_JIRA_URL`, `OPS_JIRA_EMAIL`, `OPS_JIRA_TOKEN`, `OPS_JIRA_PROJECTS` | Jira tools off |
| k8s queries (`k8s_*`) | `OPS_K8S_CONTEXTS`, `OPS_K8S_SA`, `OPS_K8S_SA_NAMESPACE` | Empty kubeconfig, k8s tools off |
| Host checks (`host_*`) | `OPS_SSH_USER`, `OPS_SSH_ALLOWED_CIDR`, `OPS_SSH_KEY` (+ `OPS_SSH_KNOWN_HOSTS`) | Host tools off |
| Host list | `OPS_SSH_INVENTORY_DIR`, `OPS_SSH_INVENTORY` (ansible inventory) | Write `~/.pacenote/ops-broker/hosts.json` directly |

```sh
# 1) Read-only k8s SA: apply sandbox/k8s/pacenote-ro.yaml to every cluster to query
# 2) Build the broker kubeconfig from the SA tokens (reads the token Secrets with the local admin kubeconfig)
pnpm k8s:kubeconfig
# 3) Bundle the broker (pnpm bundle), prepare mounts and the host list, then build and start the broker
pnpm sandbox:ops-up
```

When the inventory or an SA token changes, run the matching command and `pnpm sandbox:ops-up` again.
