#!/bin/sh
# Builds pgmetrics at the version pgscope's go.mod requires (so the report model matches),
# with pgscope's fixes from third_party/pgmetrics/*.patch applied and their tests run.
#   tools/build-pgmetrics.sh [output]                       # default ./pgmetrics
#   GOOS=linux GOARCH=amd64 tools/build-pgmetrics.sh /tmp/pgmetrics   # for a database host
# Needs Go and the Go module proxy: pgmetrics builds with its own go.mod, whose modules
# (AWS and Azure SDKs, getopt) pgscope's "go mod download" does not fetch.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-pgmetrics}
case $out in /*) ;; *) out=$(pwd)/$out ;; esac

cd "$root"
v=$(go list -m -f '{{.Version}}' github.com/rapidloop/pgmetrics)
src=$(go mod download -json "github.com/rapidloop/pgmetrics@$v" | sed -n 's/^[[:space:]]*"Dir": "\(.*\)",$/\1/p')
[ -d "$src" ] || { echo "pgmetrics $v source not found" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp -R "$src/." "$work"
chmod -R u+w "$work"
for p in "$root"/third_party/pgmetrics/*.patch; do
	patch -s -d "$work" -p1 <"$p"
done

cd "$work"
env -u GOOS -u GOARCH go test -tags timetzdata ./collector
# timetzdata: log timestamps are read in log_timezone even where the host has no zoneinfo
CGO_ENABLED=0 go build -tags timetzdata -trimpath -ldflags="-s -w -X main.version=$v+pgscope" -o "$out" ./cmd/pgmetrics
echo "built $out: pgmetrics $v+pgscope"
