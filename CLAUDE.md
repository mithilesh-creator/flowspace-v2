# Flowspace v2 — Project Guide

## What this is
Multi-tenant SaaS project-management tool with real-time Kanban, being rebuilt
from zero as Division 1 / Project #1 of a larger redevelopment sequence.
Production-grade SaaS, not a demo — this becomes a live, sellable product.

## Tech Stack
- Frontend: React, deployed on Vercel/Netlify
- Backend: Node.js + Express + Socket.io, deployed on Railway
- Auth: Supabase Auth with Row-Level Security (RLS) — NOT custom JWT
- Database: Supabase Postgres
- AI: Claude API (Anthropic) for task automation features

## Repo Structure (target)
/frontend      — React app
/backend       — Express + Socket.io server
/supabase      — SQL migrations, RLS policies, seed data
/docs          — architecture notes, API contracts

## Core Features (build in this order)
1. Multi-tenant workspace model + Supabase Auth/RLS
2. Real-time Kanban (boards, lists, cards, Socket.io sync)
3. AI task automation (auto-subtasks, priority suggestions, standup summaries)
4. Client-facing portal mode (read-only/limited external view)
5. Billing (Stripe) + onboarding flow + tenant admin panel

## Non-negotiable conventions
- Every table with tenant-scoped data MUST have RLS policies — no
  exceptions, no "we'll add it later." Multi-tenant isolation is
  correctness, not polish.
- No hardcoded secrets. All keys via environment variables, `.env.example`
  kept up to date.
- Socket.io events must be typed/documented in /docs/socket-events.md as
  they're added — don't let the event contract live only in code.
- Write a short case-study-ready summary of each completed feature
  (what it does, why it matters) — this feeds the eventual product
  catalogue listing, so keep it non-technical and outcome-focused.
- Test each feature against a multi-tenant scenario (2+ tenants) before
  considering it done — cross-tenant data leaks are the #1 risk in this
  architecture.

## Deployment
- Backend → Railway
- Frontend → Vercel or Netlify
- DB/Auth → Supabase
- Verify end-to-end in a real deployed environment before marking any
  phase complete — local-only "done" doesn't count.

## Out of scope for v2 (don't build unless asked)
- Mobile app
- Native desktop app
- Non-Stripe payment providers
