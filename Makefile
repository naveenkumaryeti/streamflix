# StreamFlix developer shortcuts.  `make help` lists everything.
SHELL := /bin/bash
COMPOSE := docker compose
ENV ?= dev
IMAGE_TAG ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo local)

.DEFAULT_GOAL := help
.PHONY: help init up down restart logs ps sh-api sh-db psql redis migrate seed setup reset test lint build sample-video helm-lint helm-template tf-plan tf-apply

help: ## Show available targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[1m%-16s\033[0m %s\n", $$1, $$2}'

init: ## Copy .env.example to .env and install workspace dependencies
	@test -f .env || cp .env.example .env
	npm install

up: ## Build and start the whole stack in the background
	$(COMPOSE) up --build -d
	@echo "web  -> http://localhost:3000"
	@echo "api  -> http://localhost:8080/api/v1"

down: ## Stop the stack (keeps volumes)
	$(COMPOSE) down

restart: ## Recreate api + worker only
	$(COMPOSE) up -d --build api worker

logs: ## Tail api and worker logs
	$(COMPOSE) logs -f api worker

ps: ## Show container status
	$(COMPOSE) ps

sh-api: ## Shell inside the api container
	$(COMPOSE) exec api sh

psql: ## Open psql against the local database
	$(COMPOSE) exec postgres psql -U streamflix -d streamflix

redis: ## Open redis-cli
	$(COMPOSE) exec redis redis-cli

migrate: ## Apply pending SQL migrations
	npm run migrate

seed: ## Load plans, genres, catalogue and demo accounts
	npm run seed

setup: ## migrate + create DynamoDB table + seed
	npm run setup

reset: ## Destroy all local data and rebuild from scratch
	$(COMPOSE) down -v
	$(COMPOSE) up --build -d

test: ## Run the backend test suite
	npm test

lint: ## Lint both workspaces
	npm run lint

build: ## Build the production frontend bundle
	npm run build

sample-video: ## Generate a short local test video you can upload in the admin UI
	bash scripts/generate-sample-video.sh

helm-lint: ## Lint the Helm chart with the $(ENV) values file
	helm lint infra/helm/streamflix -f infra/helm/streamflix/values-$(ENV).yaml

helm-template: ## Render the chart to stdout
	helm template streamflix infra/helm/streamflix -f infra/helm/streamflix/values-$(ENV).yaml

tf-plan: ## terragrunt run-all plan for $(ENV)
	cd infra/terragrunt/live/$(ENV) && terragrunt run-all plan

tf-apply: ## terragrunt run-all apply for $(ENV)
	cd infra/terragrunt/live/$(ENV) && terragrunt run-all apply
