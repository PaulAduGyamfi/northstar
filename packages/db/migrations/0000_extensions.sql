-- pgvector for embeddings beside rows (system-design §4). NS-104's image ships it; no vector
-- columns use it yet.
CREATE EXTENSION IF NOT EXISTS vector;
