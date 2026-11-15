#!/usr/bin/env bash
# Starts a throwaway MySQL-compatible server (MariaDB, or MySQL when that is what is installed) on 127.0.0.1, runs the command given with
# AGENT_TEST_MYSQL set to a root connection string, then stops the server and removes its data. Used by run-e2e.sh; does nothing but run the
# command when no server is installed (the MySQL tests then skip themselves).
#   bash connector-agent/mysql-check.sh "dotnet test connector-agent/tests/Fortress.Agent.Tests"
set -euo pipefail
cmd="${1:?give the command to run}"
server="$(command -v mariadbd || command -v mysqld || true)"
if [ -z "$server" ]; then
  echo "mysql-check: no MariaDB or MySQL server installed; MySQL tests are skipped" >&2
  exec bash -c "$cmd"
fi
port="${MYSQL_PORT_CHECK:-33069}"
dir="$(mktemp -d /tmp/agent-mysql-XXXXXX)"
user="$(id -un)"
[ "$user" = root ] && id mysql >/dev/null 2>&1 && user=mysql
chown -R "$user" "$dir" 2>/dev/null || true
install_db="$(command -v mariadb-install-db || command -v mysql_install_db || true)"
if [ -n "$install_db" ]; then
  "$install_db" --no-defaults --user="$user" --datadir="$dir/data" --auth-root-authentication-method=normal >"$dir/install.log" 2>&1
else
  "$server" --no-defaults --initialize-insecure --user="$user" --datadir="$dir/data" >"$dir/install.log" 2>&1
fi
"$server" --no-defaults --user="$user" --datadir="$dir/data" --socket="$dir/mysql.sock" --pid-file="$dir/mysql.pid" \
  --bind-address=127.0.0.1 --port="$port" --skip-name-resolve --log-error="$dir/error.log" &
pid=$!
cleanup() { kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; rm -rf "$dir"; }
trap cleanup EXIT
for _ in $(seq 1 60); do
  if [ -S "$dir/mysql.sock" ]; then break; fi
  sleep 0.5
done
[ -S "$dir/mysql.sock" ] || { echo "mysql-check: the server did not start"; cat "$dir/error.log"; exit 1; }
# Root signs in over TCP with a known password for the tests (the throwaway server is bound to 127.0.0.1 and removed afterwards).
client="$(command -v mariadb || command -v mysql)"
"$client" --no-defaults --socket="$dir/mysql.sock" -uroot -e "ALTER USER 'root'@'localhost' IDENTIFIED BY 'check-root'; CREATE USER IF NOT EXISTS 'root'@'127.0.0.1'; ALTER USER 'root'@'127.0.0.1' IDENTIFIED BY 'check-root'; GRANT ALL ON *.* TO 'root'@'127.0.0.1' WITH GRANT OPTION; FLUSH PRIVILEGES;" 2>"$dir/client.log" || { cat "$dir/client.log"; exit 1; }
export AGENT_TEST_MYSQL="Server=127.0.0.1;Port=$port;User ID=root;Password=check-root;SslMode=None"
export AGENT_TEST_MYSQL_PORT="$port"
bash -c "$cmd"
