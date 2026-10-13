# Desktop Companion — working name

Original Windows desktop companion. Local-first, personal use first; commercial packaging later. Full roadmap is in docs/product-roadmap.md. Experimental modules must expose honest capability/status rather than fake functionality. Never claim unsupported features work.

Implementation uses Electron + React + TypeScript for an installable Windows shell. Native Windows features run through bounded PowerShell/UI Automation adapters. No user API credentials in source, localStorage, prompts or logs. Local model and speech adapters must report missing dependencies honestly. No cloud fallback without explicit user enablement.
