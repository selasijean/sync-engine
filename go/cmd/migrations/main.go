package main

import (
	"database/sql"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/selasi/sync-server/migrations"
	"github.com/uptrace/bun"
	"github.com/uptrace/bun/dialect/pgdialect"
	"github.com/uptrace/bun/driver/pgdriver"
	"github.com/uptrace/bun/extra/bundebug"
	"github.com/uptrace/bun/migrate"

	"github.com/urfave/cli/v2"
)

const directory = "migrations"

func main() {
	dbURL := os.Getenv("DATABASE_URL")
	sqldb := sql.OpenDB(pgdriver.NewConnector(pgdriver.WithDSN(dbURL)))
	db := bun.NewDB(sqldb, pgdialect.New())

	db.AddQueryHook(bundebug.NewQueryHook(
		bundebug.WithEnabled(false),
		bundebug.FromEnv(),
	))

	app := &cli.App{
		Name:        "migrations",
		Description: "Manage database migrations",
		Commands:    buildCommands(migrate.NewMigrator(db, migrations.Migrations)),
	}
	if err := app.Run(os.Args); err != nil {
		log.Fatal(err)
	}
}

func buildCommands(migrator *migrate.Migrator) []*cli.Command {
	return []*cli.Command{
		{
			Name:  "migrate",
			Usage: "run all pending migrations",
			Action: func(c *cli.Context) error {
				if err := migrator.Init(c.Context); err != nil {
					return err
				}
				group, err := migrator.Migrate(c.Context)
				if err != nil {
					return err
				}
				if group.ID == 0 {
					fmt.Println("no new migrations to run")
					return nil
				}
				fmt.Printf("migrated to %s\n", group)
				return nil
			},
		},
		{
			Name:  "rollback",
			Usage: "rollback the last migration group",
			Action: func(c *cli.Context) error {
				group, err := migrator.Rollback(c.Context)
				if err != nil {
					return err
				}
				if group.ID == 0 {
					fmt.Println("no groups to roll back")
					return nil
				}
				fmt.Printf("rolled back %s\n", group)
				return nil
			},
		},
		{
			Name:  "create_sql",
			Usage: "create up and down SQL migration files",
			Action: func(c *cli.Context) error {
				name := strings.Join(c.Args().Slice(), "_")
				files, err := migrator.CreateSQLMigrations(c.Context, name)
				if err != nil {
					return err
				}
				for _, mf := range files {
					destPath := filepath.Join(directory, mf.Name)
					if err := copyFile(mf.Path, destPath); err != nil {
						return err
					}
					fmt.Printf("created migration %s (%s)\n", mf.Name, destPath)
				}
				return nil
			},
		},
		{
			Name:  "status",
			Usage: "print migration status",
			Action: func(c *cli.Context) error {
				ms, err := migrator.MigrationsWithStatus(c.Context)
				if err != nil {
					return err
				}
				fmt.Printf("migrations: %s\n", ms)
				fmt.Printf("unapplied migrations: %s\n", ms.Unapplied())
				fmt.Printf("last migration group: %s\n", ms.LastGroup())
				return nil
			},
		},
		{
			Name:  "dump_schema",
			Usage: "dump the current database schema to schema.sql",
			Action: func(c *cli.Context) error {
				dbURL := os.Getenv("DATABASE_URL")
				if dbURL == "" {
					return fmt.Errorf("DATABASE_URL is not set")
				}
				return dumpSchema(dbURL)
			},
		},
	}
}

func dumpSchema(urlStr string) error {
	config := &pgdriver.Config{}
	pgdriver.WithDSN(urlStr)(config)

	splitAddr := strings.Split(config.Addr, ":")
	if len(splitAddr) != 2 {
		return fmt.Errorf("malformed address: %s", config.Addr)
	}

	cmd := exec.Command(
		"pg_dump", "-s",
		"-h", splitAddr[0],
		"-p", splitAddr[1],
		"-U", config.User,
		config.Database,
	)
	cmd.Env = append(os.Environ(), fmt.Sprintf("PGPASSWORD=%s", config.Password))

	out, err := os.Create("./schema.sql")
	if err != nil {
		return fmt.Errorf("creating schema dump file: %w", err)
	}
	defer out.Close()

	now := time.Now().UTC().Format(time.RFC3339)
	_, _ = out.WriteString(
		"-- Schema dump created at " + now + "\n" +
			"-- Auto-generated during migration. Do not edit directly.\n\n",
	)

	cmd.Stdout = out
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("dumping schema: %w", err)
	}
	return nil
}

func copyFile(srcPath, dstPath string) error {
	src, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer src.Close()

	dst, err := os.Create(dstPath)
	if err != nil {
		return err
	}
	defer dst.Close()

	_, err = io.Copy(dst, src)
	return err
}
