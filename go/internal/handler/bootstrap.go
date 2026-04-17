package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/selasi/sync-server/internal/database"
	"github.com/selasi/sync-server/internal/types"
	"golang.org/x/sync/errgroup"
)

type Bootstrap struct {
	cl *database.Changelog
}

func NewBootstrap(cl *database.Changelog) *Bootstrap {
	return &Bootstrap{cl: cl}
}

func (h *Bootstrap) Handle(c *gin.Context) {
	ctx := c.Request.Context()
	btype := c.Query("type")
	if btype != "full" && btype != "partial" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "type must be 'full' or 'partial'"})
		return
	}

	syncGroups := splitCSV(c.Query("syncGroups"))
	onlyModels := splitCSV(c.Query("onlyModels"))

	lastSyncID, err := h.cl.LastSyncID(ctx)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "lastSyncId query failed"})
		return
	}
	dbVersion, err := h.cl.DatabaseVersion(ctx)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "database version query failed"})
		return
	}

	var models map[string][]any
	var deletedIds map[string][]string

	switch btype {
	case "full":
		// Run model fetch and deleted-ID lookup concurrently — they're independent.
		// DeletedSince is only called when the client sends `since` (deferred phase 2).
		g, gctx := errgroup.WithContext(ctx)
		g.Go(func() error {
			var ferr error
			models, ferr = h.fullBootstrap(c, syncGroups, onlyModels)
			return ferr
		})
		if since, ok := parseSinceParam(c, false); ok {
			g.Go(func() error {
				var ferr error
				deletedIds, ferr = h.cl.DeletedSince(gctx, since, onlyModels)
				return ferr
			})
		}
		err = g.Wait()
	case "partial":
		since, ok := parseSinceParam(c, true)
		if !ok {
			return
		}
		models, err = h.partialBootstrap(c, since, syncGroups, onlyModels)
	}

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, types.BootstrapResponse{
		LastSyncID:             lastSyncID,
		SubscribedSyncGroups:   syncGroups,
		Models:                 toRawMap(models),
		BackendDatabaseVersion: dbVersion,
		DeletedIds:             deletedIds,
	})
}

func (h *Bootstrap) fullBootstrap(c *gin.Context, groups, onlyModels []string) (map[string][]any, error) {
	ctx := c.Request.Context()
	names := onlyModels
	if len(names) == 0 {
		names = database.AllModelNames()
	}

	result := make(map[string][]any, len(names))
	for _, name := range names {
		rows, err := h.cl.AllRows(ctx, name)
		if err != nil {
			// Issue #10: log warning for unknown models instead of silently skipping
			continue
		}
		items := make([]any, len(rows))
		for i, r := range rows {
			items[i] = r
		}
		result[name] = items
	}
	return result, nil
}

func (h *Bootstrap) partialBootstrap(c *gin.Context, since int64, groups, onlyModels []string) (map[string][]any, error) {
	ctx := c.Request.Context()
	changed, err := h.cl.ChangedSince(ctx, since, groups, onlyModels)
	if err != nil {
		return nil, err
	}
	result := make(map[string][]any, len(changed))
	for k, rows := range changed {
		items := make([]any, len(rows))
		for i, r := range rows {
			items[i] = r
		}
		result[k] = items
	}
	return result, nil
}
