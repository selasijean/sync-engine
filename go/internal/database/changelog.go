package database

import (
	"context"
	"encoding/json"
	"time"

	"github.com/uptrace/bun"
	"github.com/uptrace/bun/dialect/pgdialect"
)

// ChangelogEntry is the append-only changelog row.
// Bun handles TEXT[] ↔ []string via the pgdialect array support.
type ChangelogEntry struct {
	bun.BaseModel `bun:"table:changelog,alias:cl"`

	ID         int64           `bun:"id,pk,autoincrement"  json:"id"`
	ModelName  string          `bun:"model_name"           json:"modelName"`
	ModelID    string          `bun:"model_id"             json:"modelId"`
	Action     string          `bun:"action"               json:"action"`
	Data       json.RawMessage `bun:"data,type:jsonb"      json:"data,omitempty"`
	SyncGroups []string        `bun:"sync_groups,array"    json:"syncGroups"`
	CreatedAt  time.Time       `bun:"created_at"           json:"createdAt"`
}

// SyncMeta is the sync_meta key/value table.
type SyncMeta struct {
	bun.BaseModel `bun:"table:sync_meta"`

	Key   string          `bun:"key,pk"`
	Value json.RawMessage `bun:"value,type:jsonb"`
}

// Changelog provides all read/write operations for the sync system.
type Changelog struct {
	DB *bun.DB
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

func (c *Changelog) LastSyncID(ctx context.Context) (int64, error) {
	var id int64
	err := c.DB.NewSelect().
		ColumnExpr("COALESCE(MAX(id), 0)").
		TableExpr("changelog").
		Scan(ctx, &id)
	return id, err
}

func (c *Changelog) DatabaseVersion(ctx context.Context) (int, error) {
	var meta SyncMeta
	err := c.DB.NewSelect().
		Model(&meta).
		Where("key = ?", "database_version").
		Scan(ctx)
	if err != nil {
		return 0, err
	}
	var v int
	json.Unmarshal(meta.Value, &v)
	return v, nil
}

// ---------------------------------------------------------------------------
// Changelog reads
// ---------------------------------------------------------------------------

// Since returns changelog entries after sinceID, filtered by sync groups.
// Used for SSE catch-up and partial bootstrap delta queries.
func (c *Changelog) Since(ctx context.Context, sinceID int64, groups []string) ([]ChangelogEntry, error) {
	var entries []ChangelogEntry
	err := c.DB.NewSelect().
		Model(&entries).
		Where("id > ?", sinceID).
		Where("sync_groups && ?::text[]", pgdialect.Array(groups)).
		OrderExpr("id ASC").
		Scan(ctx)
	return entries, err
}

// Entry returns a single changelog row by ID. Used by the Listener after
// receiving a Postgres NOTIFY with the changelog ID.
func (c *Changelog) Entry(ctx context.Context, id int64) (ChangelogEntry, error) {
	var entry ChangelogEntry
	err := c.DB.NewSelect().
		Model(&entry).
		Where("id = ?", id).
		Scan(ctx)
	return entry, err
}

// ---------------------------------------------------------------------------
// Changelog writes
// ---------------------------------------------------------------------------

// Append inserts a changelog entry. The Postgres AFTER INSERT trigger fires
// pg_notify, which the Listener picks up and feeds to the Broadcaster.
// Returns the new ID (syncId).
func (c *Changelog) Append(ctx context.Context, tx bun.Tx, entry *ChangelogEntry) error {
	_, err := tx.NewInsert().
		Model(entry).
		Returning("id").
		Exec(ctx)
	return err
}

// ---------------------------------------------------------------------------
// Model table reads (for bootstrap)
// ---------------------------------------------------------------------------

// AllRows queries a model table via Bun and returns the rows as JSON.
// Because the model structs have json tags with camelCase names, the output
// is automatically camelCase — no manual transformation needed.
func (c *Changelog) AllRows(ctx context.Context, modelName string) ([]json.RawMessage, error) {
	factory := Lookup(modelName)
	if factory == nil {
		return nil, nil
	}

	slice := factory.NewSlice()
	err := c.DB.NewSelect().Model(slice).Scan(ctx)
	if err != nil {
		return nil, err
	}

	return marshalSlice(slice)
}

// DeletedSince returns IDs of records deleted after sinceID, grouped by model name.
// Used to give clients a precise eviction list so they don't need to clearModelStore.
func (c *Changelog) DeletedSince(ctx context.Context, sinceID int64, modelNames []string) (map[string][]string, error) {
	var entries []struct {
		ModelName string `bun:"model_name"`
		ModelID   string `bun:"model_id"`
	}
	q := c.DB.NewSelect().
		ColumnExpr("model_name, model_id").
		TableExpr("changelog").
		Where("id > ?", sinceID).
		Where("action = 'D'")

	if len(modelNames) > 0 {
		q = q.Where("model_name IN (?)", bun.In(modelNames))
	}

	if err := q.Scan(ctx, &entries); err != nil {
		return nil, err
	}

	result := map[string][]string{}
	for _, e := range entries {
		result[e.ModelName] = append(result[e.ModelName], e.ModelID)
	}
	return result, nil
}

// ChangedSince finds models modified after sinceID and returns their current state.
// Groups changed IDs from the changelog, fetches current rows via Bun structs.
func (c *Changelog) ChangedSince(
	ctx context.Context, sinceID int64, groups, onlyModels []string,
) (map[string][]json.RawMessage, error) {
	// Step 1: which model/id combos changed?
	var changed []struct {
		ModelName string `bun:"model_name"`
		ModelID   string `bun:"model_id"`
		Action    string `bun:"action"`
	}
	q := c.DB.NewSelect().
		ColumnExpr("DISTINCT model_name, model_id, action").
		TableExpr("changelog").
		Where("id > ?", sinceID).
		Where("sync_groups && ?::text[]", pgdialect.Array(groups)).
		OrderExpr("model_name")

	if len(onlyModels) > 0 {
		q = q.Where("model_name IN (?)", bun.In(onlyModels))
	}

	if err := q.Scan(ctx, &changed); err != nil {
		return nil, err
	}

	// Group IDs by model type, excluding deletes (row no longer exists).
	byModel := map[string][]string{}
	for _, ch := range changed {
		if ch.Action != "D" {
			byModel[ch.ModelName] = append(byModel[ch.ModelName], ch.ModelID)
		}
	}

	// Step 2: fetch current rows for each model type using Bun structs.
	result := map[string][]json.RawMessage{}
	for modelName, ids := range byModel {
		factory := Lookup(modelName)
		if factory == nil {
			continue
		}
		slice := factory.NewSlice()
		err := c.DB.NewSelect().
			Model(slice).
			Where("id IN (?)", bun.In(ids)).
			Scan(ctx)
		if err != nil {
			return nil, err
		}
		rows, err := marshalSlice(slice)
		if err != nil {
			return nil, err
		}
		if len(rows) > 0 {
			result[modelName] = rows
		}
	}

	return result, nil
}

// ---------------------------------------------------------------------------
// Model table writes (for transactions)
// ---------------------------------------------------------------------------

// InsertModel unmarshals client JSON into a Bun model struct and inserts it.
// The json tags handle camelCase → struct field mapping.
// The bun tags handle struct field → snake_case column mapping.
func (c *Changelog) InsertModel(ctx context.Context, tx bun.Tx, modelName, modelID string, data json.RawMessage) error {
	factory := Lookup(modelName)
	if factory == nil {
		return nil
	}
	instance := factory.NewInstance()
	if err := json.Unmarshal(data, instance); err != nil {
		return err
	}
	_, err := tx.NewInsert().
		Model(instance).
		On("CONFLICT (id) DO NOTHING").
		Exec(ctx)
	return err
}

// UpdateModel loads the current row, overlays the new values, and saves it.
// The json.Unmarshal step maps camelCase property names from the client
// to Go struct fields, and Bun maps those fields to snake_case columns.
func (c *Changelog) UpdateModel(ctx context.Context, tx bun.Tx, modelName, modelID string, newValuesJSON json.RawMessage) error {
	factory := Lookup(modelName)
	if factory == nil {
		return nil
	}

	// Load current row.
	instance := factory.NewInstance()
	err := tx.NewSelect().Model(instance).Where("id = ?", modelID).Scan(ctx)
	if err != nil {
		return err
	}

	// Overlay new values. json.Unmarshal only overwrites fields present in the JSON.
	if err := json.Unmarshal(newValuesJSON, instance); err != nil {
		return err
	}

	// Save back.
	_, err = tx.NewUpdate().Model(instance).WherePK().Exec(ctx)
	return err
}

// DeleteModel removes a row from a model table.
func (c *Changelog) DeleteModel(ctx context.Context, tx bun.Tx, modelName, modelID string) error {
	factory := Lookup(modelName)
	if factory == nil {
		return nil
	}
	instance := factory.NewInstance()
	_, err := tx.NewDelete().Model(instance).Where("id = ?", modelID).Exec(ctx)
	return err
}

// RowAsJSON loads a single row and marshals it to JSON (camelCase via json tags).
// Used after an update to build the changelog data payload.
func (c *Changelog) RowAsJSON(ctx context.Context, tx bun.Tx, modelName, modelID string) (json.RawMessage, error) {
	factory := Lookup(modelName)
	if factory == nil {
		return nil, nil
	}
	instance := factory.NewInstance()
	err := tx.NewSelect().Model(instance).Where("id = ?", modelID).Scan(ctx)
	if err != nil {
		return nil, err
	}
	return json.Marshal(instance)
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

// marshalSlice takes a pointer-to-slice of Bun model structs and marshals
// each element to json.RawMessage (camelCase via json tags).
func marshalSlice(slicePtr any) ([]json.RawMessage, error) {
	// Marshal the whole slice, then unmarshal into []json.RawMessage.
	// This is simpler than reflection and works for any model type.
	b, err := json.Marshal(slicePtr)
	if err != nil {
		return nil, err
	}
	var rows []json.RawMessage
	if err := json.Unmarshal(b, &rows); err != nil {
		return nil, err
	}
	return rows, nil
}
