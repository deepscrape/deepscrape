SHELL := /bin/sh

FUNCTIONS_DIR := functions
BFF_DIR := bff
IP2LOCATION_BIN := $(FUNCTIONS_DIR)/databases/IP2LOCATION-LITE-DB11.BIN
MIGRATE_ENV_SCRIPT := $(FUNCTIONS_DIR)/scripts/migrate-env-to-json.cjs
DEPLOY_JSON_SCRIPT := $(FUNCTIONS_DIR)/scripts/deploy-with-json-config.cjs

BFF_DIR := bff
HOSTING_PROJECT := libnet-d76db

.PHONY: help lfs-install lfs-pull lfs-status lfs-refresh lfs-stage-bin ip2location-check ip2location-refresh ip2location-sync env-json deploy-json deploy-bff deploy-hosting deploy-hosting-marketing deploy-hosting-dashboard deploy-hosting-console deploy-functions deploy-all test-bff build hosting bff-image bff-local bff-push bff-deploy bff-release

help:
	@echo "Available targets:"
	@echo "  make lfs-install         - Install Git LFS hooks locally"
	@echo "  make lfs-pull            - Pull LFS files for the current checkout"
	@echo "  make lfs-status          - Show Git LFS tracked files status"
	@echo "  make lfs-refresh         - Install LFS hooks and pull the latest LFS content"
	@echo "  make lfs-stage-bin       - Stage the local IP2Location BIN into Git LFS/Git index"
	@echo "  make ip2location-check   - Verify the IP2Location BIN exists locally"
	@echo "  make env-json            - Run functions migrate-env-to-json script"
	@echo "  make ip2location-refresh - Pull LFS BIN and sync checksum/upload via migrate script"
	@echo "  make ip2location-sync    - Stage changed local BIN in Git LFS and sync checksum/upload"
	@echo "  make deploy-json         - Push FUNCTIONS_ENV_JSON and deploy using deploy-with-json-config script"
	@echo "  make deploy-bff          - Build+push the BFF image and deploy it to Cloud Run"
	@echo "  make deploy-hosting      - Deploy all three Hosting sites at once"
	@echo "  make deploy-hosting-dashboard - Deploy only dashboard.deepscrape.dev"
	@echo "  make deploy-hosting-console   - Deploy only console.deepscrape.dev"
	@echo "  make deploy-hosting-marketing - Deploy only the apex, deepscrape.dev (301s)"
	@echo "  make deploy-functions    - Push FUNCTIONS_ENV_JSON and deploy the functions"
	@echo "  make test-bff            - Run the BFF (Bun + Elysia) unit tests"
	@echo "  make deploy-all          - functions + BFF + hosting (JSON env first)"
	@echo ""
	@echo "Web app + BFF:"
	@echo "  make build               - Production web build into dist/ (prerender + service worker)"
	@echo "  make hosting             - Deploy the built web app to Firebase Hosting"
	@echo "  make bff-image           - Build the Bun/Elysia container image"
	@echo "  make bff-local           - Build and run that image locally on :8099"
	@echo "  make bff-push            - Build and push the image to Artifact Registry"
	@echo "  make bff-deploy          - Push and deploy the image to Cloud Run"
	@echo "  make bff-release         - build + hosting + bff-deploy (full release)"

lfs-install:
	git lfs install --local

lfs-pull:
	git lfs pull

lfs-status:
	git lfs ls-files

lfs-refresh: lfs-install lfs-pull

lfs-stage-bin: ip2location-check
	git add .gitattributes "$(IP2LOCATION_BIN)"
	@echo "Staged $(IP2LOCATION_BIN) for Git LFS commit"

ip2location-check:
	@test -f "$(IP2LOCATION_BIN)" || (echo "Missing $(IP2LOCATION_BIN)" && exit 1)
	@echo "Found $(IP2LOCATION_BIN)"

env-json:
	node "$(MIGRATE_ENV_SCRIPT)"

ip2location-refresh: lfs-refresh ip2location-check env-json
	@echo "IP2Location BIN synced and env JSON refreshed"

ip2location-sync: lfs-stage-bin env-json
	@echo "Local BIN staged in Git LFS and storage/checksum refreshed"

deploy-json:
	node "$(DEPLOY_JSON_SCRIPT)"

# The BFF is a Cloud Run service (firebase.json rewrites `**` -> run/deepscrape-bff),
# so hosting depends on it: deploy the BFF before hosting, always.
deploy-bff:
	cd "$(BFF_DIR)" && bun run deploy:cloud

deploy-hosting:
	firebase deploy --only hosting

# Hosting is THREE sites serving ONE build artifact (firebase.json `hosting` is an array;
# targets live in .firebaserc). `deploy-hosting` ships all three, which is right for a
# routine release. Use the per-site rules when the apex must not move yet: the apex carries
# the 301s that send app paths to the other two origins, so those have to be serving first.
# The initial cutover was done dashboard -> console -> marketing for exactly that reason.
deploy-hosting-marketing:
	firebase deploy --only hosting:marketing

deploy-hosting-dashboard:
	firebase deploy --only hosting:dashboard

deploy-hosting-console:
	firebase deploy --only hosting:console

deploy-functions: deploy-json

test-bff:
	cd "$(BFF_DIR)" && bun test

deploy-all: deploy-json deploy-bff deploy-hosting

# --- web app + Bun/Elysia BFF (Cloud Run) -------------------------------------
# The image is built from the repo ROOT (the Dockerfile COPYs bff/, functions/src,
# src/config and dist/deepscrape/browser), so the bff-* targets delegate to that
# package's scripts and each command keeps exactly one definition.
#
# Only `bff-release` deploys the web app and the BFF together. They share
# dist/deepscrape/browser: Hosting serves those bundles, and the BFF serves the CSR
# shell that references them — deploy one without the other and the shell can point
# at bundles that are gone. A rebuild with no frontend changes keeps the same
# hashes, so in that case the two are already in sync and either order is safe.

build:
	bun run build

hosting:
	firebase deploy --only hosting --project $(HOSTING_PROJECT)

bff-image:
	cd $(BFF_DIR) && bun run docker:image

bff-local:
	cd $(BFF_DIR) && bun run docker:local

bff-push:
	cd $(BFF_DIR) && bun run docker:push

bff-deploy:
	cd $(BFF_DIR) && bun run deploy:cloud

bff-release: build hosting bff-deploy
	@echo "Web app and BFF released"
