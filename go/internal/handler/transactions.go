package handler

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/uptrace/bun"
	"github.com/selasi/sync-server/internal/database"
	"github.com/selasi/sync-server/internal/types"
)

type Transactions struct {
	db *bun.DB
	cl *database.Changelog
}

func NewTransactions(db *bun.DB, cl *database.Changelog) *Transactions {
	return &Transactions{db: db, cl: cl}
}

func (h *Transactions) Handle(c *gin.Context) {
	var req types.TransactionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if len(req.Transactions) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "no transactions"})
		return
	}

	syncGroups := splitCSV(strings.TrimSpace(c.GetHeader("X-Sync-Groups")))
	ctx := c.Request.Context()

	var lastSyncID int64

	err := h.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		for _, txn := range req.Transactions {
			entry, err := h.apply(ctx, tx, txn, syncGroups)
			if err != nil {
				return fmt.Errorf("%s %s/%s: %w", txn.Action, txn.ModelName, txn.ModelID, err)
			}
			if entry.ID > lastSyncID {
				lastSyncID = entry.ID
			}
		}
		return nil
	})

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, types.TransactionResponse{Success: true, LastSyncID: lastSyncID})
}

func (h *Transactions) apply(
	ctx context.Context, tx bun.Tx, txn types.Transaction, groups []string,
) (database.ChangelogEntry, error) {
	entry := database.ChangelogEntry{
		ModelName:  txn.ModelName,
		ModelID:    txn.ModelID,
		Action:     txn.Action,
		SyncGroups: groups,
		CreatedAt:  time.Now(),
	}

	switch txn.Action {
	case "I":
		// Insert: unmarshal client JSON into a Bun model struct.
		// json tags handle camelCase → struct fields.
		// bun tags handle struct fields → snake_case columns.
		if err := h.cl.InsertModel(ctx, tx, txn.ModelName, txn.ModelID, txn.Data); err != nil {
			return entry, err
		}
		entry.Data = txn.Data

	case "U":
		// Update: extract new values from {prop: {oldValue, newValue}} format,
		// unmarshal onto existing Bun struct, save.
		newVals, err := extractNewValues(txn.Changes)
		if err != nil {
			return entry, fmt.Errorf("parse changes: %w", err)
		}
		if err := h.cl.UpdateModel(ctx, tx, txn.ModelName, txn.ModelID, newVals); err != nil {
			return entry, err
		}
		// Fetch the full updated row for the changelog (camelCase via json tags).
		rowJSON, err := h.cl.RowAsJSON(ctx, tx, txn.ModelName, txn.ModelID)
		if err != nil {
			return entry, err
		}
		entry.Data = rowJSON

	case "D", "A":
		if err := h.cl.DeleteModel(ctx, tx, txn.ModelName, txn.ModelID); err != nil {
			return entry, err
		}

	default:
		return entry, fmt.Errorf("unknown action: %s", txn.Action)
	}

	// Write changelog entry. Postgres trigger fires pg_notify → Listener → SSE.
	if err := h.cl.Append(ctx, tx, &entry); err != nil {
		return entry, err
	}
	return entry, nil
}
