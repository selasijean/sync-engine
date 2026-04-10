package sync

import (
	"fmt"
	gosync "sync"

	"github.com/selasi/sync-server/internal/database"
)

type Client struct {
	ID         string
	SyncGroups []string
	Ch         chan database.ChangelogEntry
}

type Broadcaster struct {
	mu      gosync.RWMutex
	clients map[string]*Client
	nextID  int
}

func NewBroadcaster() *Broadcaster {
	return &Broadcaster{clients: make(map[string]*Client)}
}

func (b *Broadcaster) NewClient(groups []string) *Client {
	b.mu.Lock()
	b.nextID++
	id := fmt.Sprintf("client-%d", b.nextID)
	b.mu.Unlock()

	return &Client{
		ID:         id,
		SyncGroups: groups,
		Ch:         make(chan database.ChangelogEntry, 128),
	}
}

func (b *Broadcaster) Add(c *Client)    { b.mu.Lock(); b.clients[c.ID] = c; b.mu.Unlock() }
func (b *Broadcaster) Remove(c *Client) { b.mu.Lock(); delete(b.clients, c.ID); b.mu.Unlock(); close(c.Ch) }
func (b *Broadcaster) ClientCount() int { b.mu.RLock(); defer b.mu.RUnlock(); return len(b.clients) }

// Send fans out a changelog entry to all clients whose sync groups overlap.
// Non-blocking: if a client's buffer is full, the event is dropped.
func (b *Broadcaster) Send(entry database.ChangelogEntry) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for _, c := range b.clients {
		if overlaps(c.SyncGroups, entry.SyncGroups) {
			select {
			case c.Ch <- entry:
			default:
			}
		}
	}
}

func overlaps(a, b []string) bool {
	for _, x := range a {
		for _, y := range b {
			if x == y {
				return true
			}
		}
	}
	return false
}
