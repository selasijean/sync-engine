package handler

import (
	"encoding/json"
	"strings"
)

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
