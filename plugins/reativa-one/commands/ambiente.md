---
description: Mostra PROD x STAGING, o projeto realmente ligado a este checkout, a branch e o estado dos freios
allowed-tools: ["Bash"]
---

Rode e apresente a saída, sem interpretar além dela:

```
bash "${CLAUDE_PLUGIN_ROOT}/scripts/ambiente.sh"
```

Se o projeto ligado for a PRODUÇÃO, diga isso em uma linha, no começo da
resposta. Nunca conclua o ambiente a partir de `supabase/config.toml`: o
`project_id` dele é identificador local e parece o staging.
