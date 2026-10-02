#!/usr/bin/env python3
"""Grok PreToolUse hook: deny every native Grok tool so Codex stays the sole owner of actions."""
import json

print(json.dumps({"hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Native Grok actions disabled: Codex owns execution",
}}))
