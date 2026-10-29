# Local Retention Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development with isolated file ownership, integration verification and final review.

**Goal:** Add configurable scheduled cleanup to the Docker ImgBed administration UI.
**Architecture:** Docker-local SQLite-backed retention service, authenticated management endpoints, and a native frontend settings tab built from pinned upstream source.
**Tech Stack:** Node 22, better-sqlite3, LocalR2Storage, Vue 3, Element Plus, Mocha.
**Spec:** docs/superpowers/specs/2026-10-29-local-retention-design.md

## Global constraints

- Baseline c80e236; production is unchanged in this task.
- Default disabled, videos/ subtree only, all media types, 7 days, Asia/Shanghai 03:00.
- No deletion outside local R2, no new-api access, no secrets in responses/logs.
- Real SQLite/filesystem regression tests for safety and concurrency.
- Editable frontend source and reproducible build, preserve pinned v2.7.6 behavior.

## Task 1: Durable cleanup service

- [ ] Write failing tests under test/retention-*.test.cjs covering selection boundary, preview side effects, scheduler slots/lease, changed and active files, crash recovery and index resurrection.
- [ ] Implement deploy/server/retention modules with the exact service interface in the spec; extend LocalR2Storage only for actual version/activity protection.
- [ ] Add necessary index/import seams, narrowly scoped to Docker capability, and test old queued operations plus fresh recreation.
- [ ] Run new tests and existing 79 import/storage tests; record evidence.

## Task 2: Administration UI

- [ ] Import editable official frontend source pinned to 8849d89178aec7e8b1b312d1475c0d05ced7bbd7 with license/provenance.
- [ ] Add SysCogRetention.vue and native settings navigation/translations.
- [ ] Wire saved configuration, preview, explicit deletion confirmation, progress polling and history; enforce response.ok and no automatic destructive action on page load.
- [ ] Rebuild frontend-dist cohesively and verify browser behavior locally.

## Task 3: API and server integration

- [ ] Write API tests for admin auth, Origin, JSON, unsupported runtime and confirmation errors.
- [ ] Add management routes, create the service after SQLite/R2 initialization, inject RETENTION_SERVICE and start scheduler after initialization.
- [ ] Preserve existing signal/shutdown behavior and ensure scheduler timers do not leak.
- [ ] Add operator documentation for defaults, scope, scheduling, logs and safe enablement.

## Task 4: Review and finish

- [ ] Review changed production code against deletion scope and restart guarantees.
- [ ] Run all relevant regression tests and frontend build; smoke UI with a local temporary database only.
- [ ] Commit completed feature locally and report commit, tested behavior, remaining limitations and that production is not deployed/enabled.
