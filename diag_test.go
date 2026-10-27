package main

import (
	"encoding/json"
	"regexp"
	"strings"
	"testing"

	"github.com/rapidloop/pgmetrics"
)

func diagModel() *pgmetrics.Model {
	st := func(v string) pgmetrics.Setting { return pgmetrics.Setting{Setting: v} }
	at := int64(1_700_000_000)
	return &pgmetrics.Model{
		Metadata:     pgmetrics.Metadata{At: at},
		WALLSN:       "10/0",
		IsInRecovery: true, LastXActReplayTimestamp: at - 1000, LastWALReceiveLSN: "1/2", LastWALReplayLSN: "1/1",
		IsWalReplayPaused: true,
		WALArchiving:      pgmetrics.WALArchiving{FailedCount: 1, LastFailedTime: at, LastArchivedTime: at - 10, LastFailedWAL: "000001"},
		WALReadyCount:     20, WALCount: 1000,
		NotificationQueueUsage: 0.7,
		BGWriter:               pgmetrics.BGWriter{CheckpointsTimed: 1, CheckpointsRequested: 20},
		ReplicationSlots:       []pgmetrics.ReplicationSlot{{SlotName: "s1", SlotType: "physical", RestartLSN: "1/0"}},
		ReplicationOutgoing:    []pgmetrics.ReplicationOut{{ReplayLSN: "1/0", ReplayLag: 100}},
		Subscriptions:          []pgmetrics.Subscription{{Name: "sub", DBName: "db", ApplyErrorCount: 1, SyncErrorCount: 2}},
		Backends:               []pgmetrics.Backend{{PID: 1, RoleName: "r", DBName: "db", Query: "select 1", XactStart: at - 1000, State: "idle in transaction", StateChange: at - 100, WaitEventType: "Lock"}},
		Databases: []pgmetrics.Database{{Name: "db", AgeDatFrozenXid: 2000000000, BlksHit: 1, BlksRead: 20000, XactCommit: 1, XactRollback: 2000, TempBytes: 2 << 30, TempFiles: 3, Deadlocks: 2, ChecksumFailures: 1},
			{Name: "db2", AgeDatFrozenXid: 1000000000}, {Name: "db3", AgeDatFrozenXid: 300000000}},
		Deadlocks: []pgmetrics.Deadlock{{At: at, Detail: "x\ny"}},
		Tables:    []pgmetrics.Table{{DBName: "db", SchemaName: "s", Name: "t", RelKind: "r", Size: 200 << 20, Bloat: 100 << 20, NDeadTup: 20000, NLiveTup: 20000, SeqScan: 5000, IdxScan: 1}},
		Indexes: []pgmetrics.Index{{DBName: "db", SchemaName: "s", Name: "i1", TableName: "t", Size: 20 << 20, Bloat: 10 << 20, Definition: "CREATE INDEX i1 ON s.t (a)"},
			{DBName: "db", SchemaName: "s", Name: "i2", TableName: "t", Size: 2 << 20, Definition: "CREATE INDEX i2 ON s.t (a)", IdxScan: 1}},
		Extensions:       []pgmetrics.Extension{{DBName: "db", Name: "e", InstalledVersion: "1", DefaultVersion: "2"}},
		DisabledTriggers: []pgmetrics.Trigger{{DBName: "db", SchemaName: "s", TableName: "t", Name: "tr"}},
		Tablespaces:      []pgmetrics.Tablespace{{Name: "ts", DiskUsed: 95, DiskTotal: 100}},
		Roles:            []pgmetrics.Role{{Name: "admin", Rolsuper: true, Rolcanlogin: true}},
		Settings: map[string]pgmetrics.Setting{
			"autovacuum_freeze_max_age": st("200000000"), "max_wal_size": st("1024"), "max_connections": st("1"),
			"server_version_num": st("130000"), "server_version": st("13.1"),
			"ssl": st("off"), "password_encryption": st("md5"), "listen_addresses": st("*"), "log_connections": st("off"),
			"log_disconnections": st("off"), "row_security": st("off"), "fsync": st("off"), "full_page_writes": st("off"),
			"synchronous_commit": st("off"), "data_checksums": st("off"), "wal_level": st("minimal"), "archive_mode": st("off"),
			"shared_buffers": st("16384"), "effective_cache_size": st("524288"), "work_mem": st("4096"), "maintenance_work_mem": st("65536"),
			"random_page_cost": st("4"), "checkpoint_completion_target": st("0.5"), "track_io_timing": st("off"),
			"effective_io_concurrency": st("1"), "shared_preload_libraries": st(""), "autovacuum": st("off"), "track_counts": st("off"),
			"log_min_duration_statement": st("-1"), "idle_in_transaction_session_timeout": st("0"), "log_checkpoints": st("off"),
			"log_lock_waits": st("off"), "log_autovacuum_min_duration": st("-1"), "hot_standby_feedback": st("off"), "max_slot_wal_keep_size": st("-1"),
		},
	}
}

// every diagnose and configCheck branch: no Cyrillic in English, no fmt errors, valid category_id
func TestDiagLangs(t *testing.T) {
	cyr := regexp.MustCompile(`[А-Яа-яЁё]`)
	m := diagModel()
	for _, lang := range langs {
		is, rs := diagnose(m, lang), configCheck(m, lang)
		m2 := diagModel()
		m2.System = &pgmetrics.SystemMetrics{MemUsed: 8 << 30}
		rs = append(rs, configCheck(m2, lang)...)
		b, _ := json.MarshalIndent(map[string]any{"i": is, "r": rs}, "", " ")
		s := string(b)
		if strings.Contains(s, "%!") {
			t.Errorf("%s: bad format", lang)
		}
		if lang == "en" && cyr.MatchString(s) {
			t.Errorf("en has Cyrillic: %v", cyr.FindAllStringIndex(s, 3))
		}
		if lang == "ru" && !strings.Contains(s, "Очистка") {
			t.Error("ru missing")
		}
		for _, r := range rs {
			if configCategory[r.CategoryID] == "" {
				t.Error("bad id", r.CategoryID)
			}
		}
	}
}
