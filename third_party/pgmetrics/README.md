# pgmetrics patches

`tools/build-pgmetrics.sh` applies these patches to pgmetrics at the version in `go.mod`, runs their tests
and builds the binary (version suffix `+pgscope`); `Dockerfile.agent` uses it.

| Patch | What it fixes | Upstream |
|---|---|---|
| `0001-csvlog-pg13.patch` | csvlog of PostgreSQL 13+ (24/26 columns) was skipped; csvlog needed a timestamp in `log_line_prefix` | [rapidloop/pgmetrics#89](https://github.com/rapidloop/pgmetrics/pull/89) |
| `0002-log-timezone.patch` | log timestamps were read with offset 0 unless `log_timezone` matched the pgmetrics host | [rapidloop/pgmetrics#90](https://github.com/rapidloop/pgmetrics/pull/90) |

When a pgmetrics release contains a fix, bump the version in `go.mod` and delete the patch.
