package database

import (
	"database/sql"
	"fmt"

	"github.com/uptrace/bun"
	"github.com/uptrace/bun/dialect/pgdialect"
	"github.com/uptrace/bun/driver/pgdriver"
)

// Connect creates a Bun database instance backed by pgdriver.
func Connect(databaseURL string) (*bun.DB, error) {
	connector := pgdriver.NewConnector(
		pgdriver.WithDSN(databaseURL),
	)
	sqldb := sql.OpenDB(connector)
	sqldb.SetMaxOpenConns(20)
	sqldb.SetMaxIdleConns(5)

	if err := sqldb.Ping(); err != nil {
		return nil, fmt.Errorf("ping: %w", err)
	}

	db := bun.NewDB(sqldb, pgdialect.New())
	return db, nil
}
