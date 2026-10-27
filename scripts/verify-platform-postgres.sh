#!/usr/bin/env bash
set -euo pipefail

task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root"
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Node.js >= 22 is required")'

task_pg_bin="${BGP_POSTGRES_BIN:-}"
if [[ -z "$task_pg_bin" ]]; then
  if command -v initdb >/dev/null 2>&1; then
    task_pg_bin="$(dirname "$(command -v initdb)")"
  elif [[ -x /opt/homebrew/opt/postgresql@17/bin/initdb ]]; then
    task_pg_bin=/opt/homebrew/opt/postgresql@17/bin
  else
    echo 'Set BGP_POSTGRES_BIN to a PostgreSQL installation containing initdb, pg_ctl and createdb.' >&2
    exit 1
  fi
fi
for task_pg_tool in initdb pg_ctl createdb; do
  [[ -x "$task_pg_bin/$task_pg_tool" ]] || {
    echo "Missing PostgreSQL tool: $task_pg_tool" >&2
    exit 1
  }
done

task_pg_dir="$(mktemp -d "${TMPDIR:-/tmp}/bgp-platform.XXXXXX")"
task_pg_started=0
cleanup() {
  task_exit_status=$?
  trap - EXIT
  if [[ "$task_pg_started" == 1 ]]; then
    "$task_pg_bin/pg_ctl" -D "$task_pg_dir/data" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if [[ "$task_exit_status" == 0 ]]; then
    rm -rf "$task_pg_dir"
  else
    echo "Platform PostgreSQL verification failed; logs remain in $task_pg_dir" >&2
  fi
  exit "$task_exit_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

task_pg_port="$(node --input-type=module -e 'import {createServer} from "node:net"; const server=createServer(); server.listen(0,"127.0.0.1",()=>{console.log(server.address().port);server.close();});')"
"$task_pg_bin/initdb" -D "$task_pg_dir/data" -A trust -U bgp_test >"$task_pg_dir/init.log"
"$task_pg_bin/pg_ctl" -D "$task_pg_dir/data" -l "$task_pg_dir/server.log" \
  -o "-h 127.0.0.1 -p $task_pg_port -k $task_pg_dir" -w -t 15 start
task_pg_started=1
"$task_pg_bin/createdb" -h 127.0.0.1 -p "$task_pg_port" -U bgp_test bgp_platform_test

export BGP_TEST_DATABASE_URL="postgresql://bgp_test@127.0.0.1:$task_pg_port/bgp_platform_test"
corepack pnpm verify:platform
RUN_POSTGRES_TESTS=1 corepack pnpm \
  --filter '@board-game/*' \
  --filter '@board-platform/*' \
  -r test
