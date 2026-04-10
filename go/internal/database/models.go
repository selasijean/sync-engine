package database

import (
	"time"

	"github.com/uptrace/bun"
)

// ---------------------------------------------------------------------------
// Domain models. Bun tags map to Postgres columns (snake_case).
// JSON tags map to the client's property names (camelCase).
// This dual tagging is what solves the snake_case → camelCase issue:
//   Postgres: team_id → Go struct: TeamID → JSON: teamId
// ---------------------------------------------------------------------------

type Issue struct {
	bun.BaseModel `bun:"table:issues,alias:i"`

	ID          string    `bun:"id,pk,type:uuid"        json:"id"`
	Title       string    `bun:"title"                   json:"title"`
	Description string    `bun:"description"             json:"description"`
	Priority    int       `bun:"priority"                json:"priority"`
	SortOrder   int       `bun:"sort_order"              json:"sortOrder"`
	TeamID      *string   `bun:"team_id,type:uuid"       json:"teamId"`
	AssigneeID  *string   `bun:"assignee_id,type:uuid"   json:"assigneeId"`
	CreatedAt   time.Time `bun:"created_at"              json:"createdAt"`
	UpdatedAt   time.Time `bun:"updated_at"              json:"updatedAt"`
}

type Team struct {
	bun.BaseModel `bun:"table:teams,alias:t"`

	ID        string    `bun:"id,pk,type:uuid"  json:"id"`
	Name      string    `bun:"name"             json:"name"`
	Key       string    `bun:"key"              json:"key"`
	CreatedAt time.Time `bun:"created_at"       json:"createdAt"`
	UpdatedAt time.Time `bun:"updated_at"       json:"updatedAt"`
}

type User struct {
	bun.BaseModel `bun:"table:users,alias:u"`

	ID        string    `bun:"id,pk,type:uuid"  json:"id"`
	Name      string    `bun:"name"             json:"name"`
	Email     string    `bun:"email"            json:"email"`
	CreatedAt time.Time `bun:"created_at"       json:"createdAt"`
	UpdatedAt time.Time `bun:"updated_at"       json:"updatedAt"`
}
