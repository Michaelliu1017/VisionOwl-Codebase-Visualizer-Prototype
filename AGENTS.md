# VisionOwl Agent Instructions

When the user asks to install, configure, launch, deploy, or troubleshoot VisionOwl on a local machine, load and follow `.agents/skills/visionowl-local-deploy/SKILL.md`.

Keep the Local Agent loopback-only. VisionOwl accepts repositories selected by the user at runtime; require a real local Git repository and never analyze `/` or the user home directory.
