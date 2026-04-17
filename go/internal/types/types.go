package types

import (
	"encoding/json"
)

// BootstrapResponse is returned by GET /api/bootstrap.
type BootstrapResponse struct {
	LastSyncID             int64                        `json:"lastSyncId"`
	SubscribedSyncGroups   []string                     `json:"subscribedSyncGroups"`
	Models                 map[string][]json.RawMessage `json:"models"`
	BackendDatabaseVersion int                          `json:"backendDatabaseVersion"`
	// DeletedIds lists record IDs deleted since the client's lastSyncId, grouped
	// by model name. Only present when the client sends a `since` param with a
	// full bootstrap request (deferred model phase). Omitted otherwise.
	DeletedIds map[string][]string `json:"deletedIds,omitempty"`
}

// TransactionRequest is the body of POST /api/transactions.
type TransactionRequest struct {
	Transactions []Transaction `json:"transactions"`
}

// Transaction is one client mutation within a batch.
type Transaction struct {
	ID        string          `json:"id"`
	Action    string          `json:"action"`
	ModelName string          `json:"modelName"`
	ModelID   string          `json:"modelId"`
	Data      json.RawMessage `json:"data,omitempty"`
	Changes   json.RawMessage `json:"changes,omitempty"`
}

// TransactionResponse is returned by POST /api/transactions.
type TransactionResponse struct {
	Success    bool  `json:"success"`
	LastSyncID int64 `json:"lastSyncId"`
}
