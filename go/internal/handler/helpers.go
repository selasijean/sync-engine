package handler

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

// parseSinceParam reads the "since" query param, parses it as int64, and writes
// a 400 response on failure. Returns (0, false) when the param is absent and
// required is false. Returns (0, false) and writes 400 when absent and required.
func parseSinceParam(c *gin.Context, required bool) (int64, bool) {
	s := c.Query("since")
	if s == "" {
		if required {
			c.JSON(http.StatusBadRequest, gin.H{"error": "partial requires 'since'"})
		}
		return 0, false
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid since param"})
		return 0, false
	}
	return v, true
}

func splitCSV(s string) []string {
	if s == "" {
		return nil
	}
	return strings.Split(s, ",")
}

func toRawMap(m map[string][]any) map[string][]json.RawMessage {
	out := make(map[string][]json.RawMessage, len(m))
	for k, items := range m {
		msgs := make([]json.RawMessage, len(items))
		for i, item := range items {
			switch v := item.(type) {
			case json.RawMessage:
				msgs[i] = v
			default:
				b, _ := json.Marshal(v)
				msgs[i] = b
			}
		}
		out[k] = msgs
	}
	return out
}

// extractNewValues parses {prop: {oldValue, newValue}} → JSON of {prop: newValue}
// The output is a JSON object that can be unmarshaled onto a Bun model struct.
func extractNewValues(changes json.RawMessage) (json.RawMessage, error) {
	var parsed map[string]struct {
		NewValue json.RawMessage `json:"newValue"`
	}
	if err := json.Unmarshal(changes, &parsed); err != nil {
		return nil, err
	}
	result := map[string]json.RawMessage{}
	for k, v := range parsed {
		result[k] = v.NewValue
	}
	return json.Marshal(result)
}
