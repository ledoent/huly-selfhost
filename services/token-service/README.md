# Huly Token Service

Optional HTTP service for minting, listing, and revoking Huly API tokens.
Resolves user emails and workspace slugs to UUIDs automatically via CockroachDB.

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `SERVER_SECRET` | Shared Huly secret (same as transactor/account) | Yes |
| `DB_URL` | CockroachDB connection string | Yes |
| `PORT` | Listen port (default: `3500`) | No |

## Endpoints

All endpoints require `X-Server-Secret` header (except `/healthz`).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/healthz` | Health check |
| `POST` | `/tokens` | Mint a token |
| `GET` | `/tokens` | List token metadata |
| `DELETE` | `/tokens/:id` | Soft-revoke a token |

### Mint a token

```bash
curl -X POST http://localhost:3500/tokens \
  -H "X-Server-Secret: $SERVER_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "workspace": "my-workspace", "expiryDays": 30}'
```

Response: `{ "id": "...", "token": "<jwt>", "expiresAt": "2026-04-09T..." }`

## Deployment

### Kubernetes (raw manifests)

```bash
# Build and push the image
docker build -t ghcr.io/<org>/huly-token-service:latest services/token-service/
docker push ghcr.io/<org>/huly-token-service:latest

# Apply manifests (update host in ingress first)
kubectl apply -f kube/token-service/
```

The manifests reference `huly-secret` for `SERVER_SECRET` and `CR_DB_URL` — the same secret used by the transactor.

### Swagger UI ConfigMap

The Swagger UI deployment requires the OpenAPI spec as a ConfigMap. Generate it from the canonical spec:

```bash
kubectl create configmap openapi-spec \
  --from-file=openapi.yaml=docs/openapi.yaml \
  --dry-run=client -o yaml | kubectl apply -n <namespace> -f -
```

### Local development

```bash
cd services/token-service
npm install
SERVER_SECRET=<secret> DB_URL=<crdb-url> npm run dev
```
