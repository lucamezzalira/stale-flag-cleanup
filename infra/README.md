# Infra (AWS)

Deferred until the local scout/surgeon loop works end-to-end.

Planned CDK stack:

- S3 + CloudFront for Featurevisor datafiles
- EventBridge Scheduler (midnight UTC) invoking scout
- AgentCore Runtime for surgeon (OpenAI-compatible model base URL env)
- Secrets Manager for GitHub + Tinybird tokens via AgentCore Identity

No AgentCore Gateway in front of Tinybird.
