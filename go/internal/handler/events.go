package handler

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/selasi/sync-server/internal/database"
	gosync "github.com/selasi/sync-server/internal/sync"
)

type Events struct {
	broadcaster *gosync.Broadcaster
	cl          *database.Changelog
}

func NewEvents(b *gosync.Broadcaster, cl *database.Changelog) *Events {
	return &Events{broadcaster: b, cl: cl}
}

func (h *Events) Handle(c *gin.Context) {
	lastSyncID, _ := strconv.ParseInt(c.DefaultQuery("lastSyncId", "0"), 10, 64)
	groups := splitCSV(c.DefaultQuery("syncGroups", ""))

	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache")
	c.Writer.Header().Set("Connection", "keep-alive")
	c.Writer.Header().Set("X-Accel-Buffering", "no")

	client := h.broadcaster.NewClient(groups)
	h.broadcaster.Add(client)
	defer h.broadcaster.Remove(client)

	ctx := c.Request.Context()
	flusher := c.Writer.(http.Flusher)

	// Phase 1: catch-up
	missed, err := h.cl.Since(ctx, lastSyncID, groups)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "catch-up failed"})
		return
	}
	for _, entry := range missed {
		data, _ := json.Marshal(entry)
		fmt.Fprintf(c.Writer, "data: %s\n\n", data)
		flusher.Flush()
	}

	// Phase 2: live streaming
	c.Stream(func(w io.Writer) bool {
		select {
		case entry, ok := <-client.Ch:
			if !ok {
				return false
			}
			data, _ := json.Marshal(entry)
			fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()
			return true
		case <-ctx.Done():
			return false
		}
	})
}
