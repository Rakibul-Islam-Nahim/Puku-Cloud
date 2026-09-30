// SPDX-License-Identifier: Apache-2.0
package store

// This file previously hosted the agent's optional Postgres connector.
// PostgreSQL has been removed from the agent's data path. The agent now
// uses SQLite exclusively (see store.go). All multi-agent coordination
// happens via Temporal workflow orchestration, not a shared database.
//
// We keep the file's exported helpers but route them to SQLite-only paths.
// Setting PUKUCLOUD_DB_DRIVER=postgres returns a clear error at Open time.

import (
	"database/sql"
	"fmt"

	"github.com/pukucloud/agent/migrations"

	"github.com/pressly/goose/v3"
)

// openSQLiteDB opens the agent's local SQLite database. This is the only
// database driver the agent supports now.
func openSQLiteDB(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite",
		path+"?_journal_mode=WAL&_busy_timeout=30000&_synchronous=NORMAL&_txlock=immediate")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)
	return db, nil
}

// RunMigrationCommand runs a goose migration command (up/down/status)
// against the open *sql.DB. PG is rejected.
func RunMigrationCommand(driverName string, db *sql.DB, command string) error {
	if normalizeDriver(driverName) != "sqlite" {
		return fmt.Errorf("only sqlite is supported; driver=%q (postgres removed)", driverName)
	}
	if err := goose.SetDialect("sqlite3"); err != nil {
		return err
	}
	goose.SetBaseFS(migrations.FS)
	switch command {
	case "up":
		return goose.Up(db, "sqlite")
	case "down":
		return goose.DownTo(db, "sqlite", 0)
	case "status":
		return goose.Status(db, "sqlite")
	default:
		return fmt.Errorf("unknown migration command %q", command)
	}
}

// openPostgresDB previously opened a pgx connection to a control-plane
// Postgres. With the move to Temporal + D1 + DO, there is no shared DB
// for the agent. Returning an error here makes any leftover config that
// still tries PG fail loudly instead of silently doing the wrong thing.
func openPostgresDB(dsn string) (*sql.DB, error) {
	return nil, fmt.Errorf("postgres driver is no longer supported; agent uses SQLite. " +
		"Multi-agent coordination now goes through Temporal (see agent/internal/temporal/). " +
		"Remove PUKUCLOUD_DB_DRIVER=postgres from your environment.")
}

// runMigrations runs the embedded migrations against the open *sql.DB.
// PG is rejected; only SQLite is supported.
func runMigrations(driverName string, db *sql.DB) error {
	if normalizeDriver(driverName) != "sqlite" {
		return fmt.Errorf("only sqlite is supported; driver=%q (postgres removed)", driverName)
	}
	if err := goose.SetDialect("sqlite3"); err != nil {
		return err
	}
	goose.SetBaseFS(migrations.FS)
	return goose.Up(db, "sqlite")
}

// OpenDBForDriver opens the SQLite database. PG returns an error.
func OpenDBForDriver(driverName, dsn string) (*sql.DB, error) {
	switch normalizeDriver(driverName) {
	case "sqlite":
		return openSQLiteDB(dsn)
	case "postgres":
		return nil, fmt.Errorf("postgres driver is no longer supported; use Temporal + D1 + DO")
	default:
		return nil, fmt.Errorf("unsupported PUKUCLOUD_DB_DRIVER %q (only sqlite is supported)", driverName)
	}
}

func normalizeDriver(driverName string) string {
	switch driverName {
	case "postgres", "postgresql", "pgx":
		return "postgres"
	case "", "sqlite", "sqlite3":
		return "sqlite"
	default:
		return driverName
	}
}