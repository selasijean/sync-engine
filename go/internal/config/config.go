package config

import "os"

type ServiceMode string

const (
	ModeAll       ServiceMode = "all"
	ModeStateless ServiceMode = "stateless"
	ModeStateful  ServiceMode = "stateful"
)

type Config struct {
	DatabaseURL string
	Port        string
	Mode        ServiceMode
}

func Load() Config {
	return Config{
		DatabaseURL: env("DATABASE_URL", "postgres://postgres:password@localhost:5432/syncdb?sslmode=disable"),
		Port:        env("PORT", "8080"),
		Mode:        ServiceMode(env("SERVICE_MODE", "all")),
	}
}

func (c Config) RunsAPI() bool { return c.Mode == ModeAll || c.Mode == ModeStateless }
func (c Config) RunsSSE() bool { return c.Mode == ModeAll || c.Mode == ModeStateful }

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
