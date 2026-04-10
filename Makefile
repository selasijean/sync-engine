.PHONY: help start-backend stop-backend run-webapp install-webapp go-tidy logs ps clean

help:
	@echo ""
	@echo "  make go-tidy         Generate go.sum (run once after cloning)"
	@echo "  make start-backend   Postgres + API (:8080) + SSE (:8081)"
	@echo "  make stop-backend    Stop all backend services"
	@echo "  make install-webapp  npm install in webapp/"
	@echo "  make run-webapp      Next.js dev server on :3000"
	@echo "  make logs            Tail backend logs"
	@echo "  make ps              Show running containers"
	@echo "  make clean           Stop + wipe postgres volume"
	@echo ""

# Run this once after cloning to generate go.sum.
# Required before docker build or go run.
go-tidy:
	cd go && go mod tidy

start-backend:
	docker compose up -d --build
	@echo ""
	@echo "  API:      http://localhost:8080  (bootstrap, transactions)"
	@echo "  SSE:      http://localhost:8081  (events stream)"
	@echo "  Postgres: localhost:5432         (syncdb / postgres:password)"
	@echo ""

stop-backend:
	docker compose down

install-webapp:
	cd webapp && npm install

run-webapp: install-webapp
	cd webapp && npm run dev

logs:
	docker compose logs -f api sse

ps:
	docker compose ps

clean:
	docker compose down -v
