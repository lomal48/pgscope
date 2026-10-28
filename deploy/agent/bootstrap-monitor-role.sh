#!/bin/sh
# shellcheck disable=SC2016  # single-quoted $ are meant for the container shell / psql
# Create or update the pgscope monitoring role in the PostgreSQL containers of
# this Docker host. SQL reaches psql on stdin through `docker exec -i`, so the
# password never shows up in a process list. Safe to run again: an existing role
# only gets the new password. Run it on every Docker host / Swarm node with databases.
set -eu

usage() {
	cat <<'EOF'
Usage: bootstrap-monitor-role.sh [options] [container...]

Creates the PostgreSQL role for pgscope-agent (LOGIN, member of pg_monitor), or
sets a new password if it exists, in every running container labelled
pgscope.enable=true, or only in the containers given. Standbys (the role comes
from the primary) and pgscope.kind=pgbouncer containers are skipped.

Options:
  --password-file FILE       role password (default: ./secrets/pgscope_monitor_password)
  --role NAME                role name (default: pgscope_monitor)
  --label KEY=VALUE          label that marks the containers (default: pgscope.enable=true)
  --with-pg-stat-statements  also CREATE EXTENSION IF NOT EXISTS pg_stat_statements
                             in every database that accepts connections
  --dry-run                  change nothing, only show what would be done
  -h, --help                 this help

psql runs inside the container as ${POSTGRES_USER:-postgres} over the local
socket, which the official postgres image trusts.
EOF
}

die() {
	echo "bootstrap-monitor-role: $*" >&2
	exit 2
}

role=pgscope_monitor
pwfile=./secrets/pgscope_monitor_password
label=pgscope.enable=true
pss=0
dry=0
while [ $# -gt 0 ]; do
	case $1 in
	--password-file) [ $# -ge 2 ] || die "$1 needs a value"; pwfile=$2; shift 2 ;;
	--role) [ $# -ge 2 ] || die "$1 needs a value"; role=$2; shift 2 ;;
	--label) [ $# -ge 2 ] || die "$1 needs a value"; label=$2; shift 2 ;;
	--with-pg-stat-statements) pss=1; shift ;;
	--dry-run) dry=1; shift ;;
	-h | --help) usage; exit 0 ;;
	--) shift; break ;;
	-*) usage >&2; die "unknown option $1" ;;
	*) break ;;
	esac
done

case $role in
'' | [!a-z_]* | *[!a-z0-9_]*) die "role name must match [a-z_][a-z0-9_]*: $role" ;;
esac
[ -r "$pwfile" ] || die "cannot read the password file $pwfile"
pw=$(cat "$pwfile")
[ -n "$pw" ] || die "the password file $pwfile is empty"
tag='$pgscope_pw$'
case $pw in *"$tag"*) die "the password must not contain $tag" ;; esac
pwsql=$(printf '%s' "$pw" | sed "s/'/''/g")

# psql_in CONTAINER DB [psql args]: psql inside the container, SQL on stdin.
psql_in() {
	_c=$1 _d=$2
	shift 2
	docker exec -i "$_c" sh -c 'd=$1; shift; exec psql -X -q -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "$d" "$@"' sh "$_d" "$@"
}

# query CONTAINER DB SQL: one read-only query, unaligned output without headers.
query() {
	printf '%s\n' "$3" | psql_in "$1" "$2" -At
}

setup_role() {
	# keep the statement with the password out of the server log and pg_stat_statements
	# (pgmetrics would ship pg_stat_statements to pgscope)
	psql_in "$1" postgres <<EOF
SET client_min_messages = warning;
SET log_statement = none;
SET log_min_duration_statement = -1;
SET log_min_error_statement = panic;
SET pg_stat_statements.track_utility = off;
DO $tag
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$role') THEN
    CREATE ROLE $role LOGIN PASSWORD '$pwsql';
  ELSE
    ALTER ROLE $role WITH LOGIN PASSWORD '$pwsql';
  END IF;
END
$tag;
GRANT pg_monitor TO $role;
EOF
}

setup_pss() {
	dbs=$(query "$1" postgres "SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY 1") || return 1
	while IFS= read -r db; do
		[ -n "$db" ] || continue
		# any user with CREATEDB names databases, and psql -d takes a name with = or :// for a
		# connection string (host=elsewhere would get this superuser session); the agent skips them too
		case $db in
		*=* | *://*)
			echo "$2: skipped database $db: psql would read its name as a connection string" >&2
			continue
			;;
		esac
		if [ $dry = 1 ]; then
			echo "$2: would CREATE EXTENSION IF NOT EXISTS pg_stat_statements in $db"
		else
			echo 'SET client_min_messages = warning; CREATE EXTENSION IF NOT EXISTS pg_stat_statements;' |
				psql_in "$1" "$db" || return 1
			echo "$2: pg_stat_statements in $db"
		fi
	done <<EOF
$dbs
EOF
	case ,$(query "$1" postgres "SELECT replace(current_setting('shared_preload_libraries'), ' ', '')"), in
	*,pg_stat_statements,*) ;;
	*) echo "$2: pg_stat_statements is not in shared_preload_libraries; add -c shared_preload_libraries=pg_stat_statements to the container command and restart it" ;;
	esac
}

if [ $# -gt 0 ]; then
	containers=$*
else
	containers=$(docker ps -q --filter "label=$label" --filter status=running)
fi
if [ -z "$containers" ]; then
	echo "no running containers with label $label"
	exit 0
fi

failed=0
# shellcheck disable=SC2086  # split on purpose: container names and ids have no spaces
for c in $containers; do
	if ! info=$(docker inspect -f '{{.Name}} {{index .Config.Labels "pgscope.kind"}}' "$c"); then
		failed=$((failed + 1))
		continue
	fi
	name=${info%% *}
	name=${name#/}
	if [ "${info#* }" = pgbouncer ]; then
		echo "$name: pgbouncer, skipped"
		continue
	fi
	if ! standby=$(query "$c" postgres 'SELECT pg_is_in_recovery()'); then
		echo "$name: psql failed, skipped" >&2
		failed=$((failed + 1))
		continue
	fi
	if [ "$standby" = t ]; then
		echo "$name: standby, skipped (the role replicates from the primary)"
		continue
	fi
	if [ $dry = 1 ]; then
		echo "$name: would create role $role or set its password, and GRANT pg_monitor"
	elif setup_role "$c"; then
		echo "$name: role $role ready"
	else
		echo "$name: role setup failed" >&2
		failed=$((failed + 1))
		continue
	fi
	if [ $pss = 1 ] && ! setup_pss "$c" "$name"; then
		echo "$name: pg_stat_statements setup failed" >&2
		failed=$((failed + 1))
	fi
done

[ $failed = 0 ] || die "$failed container(s) failed"
