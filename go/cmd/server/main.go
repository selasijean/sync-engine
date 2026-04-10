package main

import (
	"context"
	"log"
	"os/signal"
	"syscall"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/selasi/sync-server/internal/config"
	"github.com/selasi/sync-server/internal/database"
	"github.com/selasi/sync-server/internal/handler"
	gosync "github.com/selasi/sync-server/internal/sync"
)

func main() {
	cfg := config.Load()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Bun DB — used for all ORM queries (handlers, changelog, bootstrap).
	bunDB, err := database.Connect(cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("bun connect: %v", err)
	}
	defer bunDB.Close()

	cl := &database.Changelog{DB: bunDB}

	// Router
	r := gin.Default()
	r.Use(cors.New(cors.Config{
		AllowOrigins:  []string{"http://localhost:3000"},
		AllowMethods:  []string{"GET", "POST", "OPTIONS"},
		AllowHeaders:  []string{"Content-Type", "X-Sync-Groups", "Cache-Control"},
		ExposeHeaders: []string{"Content-Type"},
	}))

	api := r.Group("/api")
	api.GET("/health", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "ok", "mode": cfg.Mode})
	})

	// Stateless: REST API
	if cfg.RunsAPI() {
		api.GET("/bootstrap", handler.NewBootstrap(cl).Handle)
		api.POST("/transactions", handler.NewTransactions(bunDB, cl).Handle)
		log.Println("[api] registered /api/bootstrap, /api/transactions")
	}

	// Stateful: SSE + Postgres listener
	if cfg.RunsSSE() {
		// pgx pool — only used for LISTEN/NOTIFY (Bun doesn't expose notification API).
		// One dedicated connection is enough.
		pgxCfg, _ := pgxpool.ParseConfig(cfg.DatabaseURL)
		pgxCfg.MaxConns = 2
		pgxPool, err := pgxpool.NewWithConfig(ctx, pgxCfg)
		if err != nil {
			log.Fatalf("pgx connect: %v", err)
		}
		defer pgxPool.Close()

		broadcaster := gosync.NewBroadcaster()
		listener := gosync.NewListener(pgxPool, cl, func(entry database.ChangelogEntry) {
			broadcaster.Send(entry)
		})
		go listener.Start(ctx)

		api.GET("/events", handler.NewEvents(broadcaster, cl).Handle)
		api.GET("/stats", func(c *gin.Context) {
			c.JSON(200, gin.H{"clients": broadcaster.ClientCount()})
		})
		log.Println("[sse] registered /api/events, started listener")
	}

	log.Printf("mode=%s port=%s", cfg.Mode, cfg.Port)
	go func() {
		if err := r.Run(":" + cfg.Port); err != nil {
			log.Fatalf("server: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("shutting down")
}
