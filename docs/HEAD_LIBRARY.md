# Head as the NestNyx constitution library

Head remains the stable Yaro constitution: architecture, governance, command language, naming and generation contracts.

NestNyx now consumes the verified canonical Head bundle through a read-only in-process library cache. The runtime still checks current authority before command execution, but unchanged Head bytes are reused rather than repeatedly re-downloaded and reparsed.

## Authority boundary

- Canonical Head lifecycle remains governed by Yaro generation and promotion rules.
- NestNyx does not silently rewrite or relabel Head.
- The public repository contains the interpreter and library adapter, not private generated Head payloads.
- Google Drive remains the current durable canonical source while the runtime-library migration proceeds.
- Future storage migration may change where canonical Head bytes are persisted, but must preserve version/hash authority and the same constitution semantics.

In short: NestNyx owns the interpreter and runtime library; Head owns the constitution.
