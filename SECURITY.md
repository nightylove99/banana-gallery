# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Banana Gallery (such as authentication bypass, unintended file/path access, credential leakage, or unsafe network exposure), **please do not open a public GitHub Issue**.

Instead, please report it privately using GitHub's **Security Advisories ("Report a vulnerability")** feature on this repository, or contact the maintainer directly.

Please include:

- Banana Gallery version and platform (Windows / macOS / Linux)
- Minimal steps to reproduce
- Impact assessment

## Important Reminder for All Issues and Reports

**Never paste any of the following into public issues, pull requests, or logs:**

- API keys (`GEMINI_API_KEY`, `OPENAI_IMAGE_API_KEY`, etc.) or `BANANA_GALLERY_API_TOKEN`
- Google Cloud Service Account JSON files
- Private proxy URLs containing credentials
- Private prompts or personal reference images
