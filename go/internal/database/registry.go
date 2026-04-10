package database

import "log"

// ---------------------------------------------------------------------------
// Model registry. Maps client model names to Go struct factories.
// Bun uses the struct's bun tags to determine the table and columns.
//
// When the bootstrap handler receives onlyModels=["Issue","Team"], it calls
// NewSlice("Issue") to get a *[]Issue, queries via Bun, then marshals to JSON
// (which uses the json tags for camelCase output).
//
// Extend this when you add domain models.
// ---------------------------------------------------------------------------

type ModelFactory struct {
	// NewSlice returns a pointer to an empty slice of the model struct.
	// Example: for "Issue", returns &[]Issue{}
	NewSlice func() any

	// NewInstance returns a pointer to a zero-value model struct.
	// Example: for "Issue", returns &Issue{}
	NewInstance func() any

	// Table is the Postgres table name (for raw queries in the listener).
	Table string
}

var registry = map[string]ModelFactory{
	"Issue": {
		NewSlice:    func() any { return &[]Issue{} },
		NewInstance: func() any { return &Issue{} },
		Table:       "issues",
	},
	"Team": {
		NewSlice:    func() any { return &[]Team{} },
		NewInstance: func() any { return &Team{} },
		Table:       "teams",
	},
	"User": {
		NewSlice:    func() any { return &[]User{} },
		NewInstance: func() any { return &User{} },
		Table:       "users",
	},
}

// Lookup returns the factory for a model name, or nil if unknown.
func Lookup(modelName string) *ModelFactory {
	f, ok := registry[modelName]
	if !ok {
		log.Printf("[registry] unknown model: %s", modelName)
		return nil
	}
	return &f
}

// AllModelNames returns every registered model name.
func AllModelNames() []string {
	names := make([]string, 0, len(registry))
	for name := range registry {
		names = append(names, name)
	}
	return names
}

// TableFor returns the Postgres table name for a model, or "".
func TableFor(modelName string) string {
	if f, ok := registry[modelName]; ok {
		return f.Table
	}
	return ""
}
