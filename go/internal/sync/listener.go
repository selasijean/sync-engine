package sync

import (
	"context"
	"log"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/selasi/sync-server/internal/database"
)

// Listener subscribes to Postgres LISTEN/NOTIFY on changelog_changes.
// Uses pgx for the notification channel (Bun doesn't expose this API).
// Uses the Bun-backed Changelog to query the full row.
type Listener struct {
	pgxPool   *pgxpool.Pool
	changelog *database.Changelog
	onChange  func(database.ChangelogEntry)
}

func NewListener(pgxPool *pgxpool.Pool, cl *database.Changelog, fn func(database.ChangelogEntry)) *Listener {
	return &Listener{pgxPool: pgxPool, changelog: cl, onChange: fn}
}

func (l *Listener) Start(ctx context.Context) {
	for {
		if err := l.listen(ctx); err != nil {
			log.Printf("[listener] %v — reconnecting in 3s", err)
			select {
			case <-time.After(3 * time.Second):
			case <-ctx.Done():
				return
			}
		}
	}
}

func (l *Listener) listen(ctx context.Context) error {
	conn, err := l.pgxPool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, "LISTEN changelog_changes"); err != nil {
		return err
	}
	log.Println("[listener] subscribed to changelog_changes")

	for {
		notif, err := conn.Conn().WaitForNotification(ctx)
		if err != nil {
			return err
		}

		id, err := strconv.ParseInt(notif.Payload, 10, 64)
		if err != nil {
			log.Printf("[listener] bad payload: %q", notif.Payload)
			continue
		}

		entry, err := l.changelog.Entry(ctx, id)
		if err != nil {
			log.Printf("[listener] query %d: %v", id, err)
			continue
		}

		l.onChange(entry)
	}
}
