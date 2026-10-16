# Teste L1 — as regras da Camada 0 casam com os nomes da CLI?

Mede se `mcp__claude_ai_<Nome>__<ferramenta>` em `permissions.deny` remove de fato
as ferramentas de um conector do claude.ai na linha de comando. **Não chama
nenhuma ferramenta MCP**: só `ToolSearch`, que lista nomes.

## Preparo (fora do repositório)
Duas pastas vazias, cada uma com um `.claude/settings.json`:
- `controle-antes/`: o `settings.json` do commit anterior à correção;
- `corrigido-depois/`: o `settings.json` com a correção.

## Execução (uma vez em cada pasta)
```bash
cd <pasta>
ENABLE_CLAUDEAI_MCP_SERVERS=true claude -p "<pedido abaixo>" \
  --permission-mode plan --output-format stream-json --verbose --max-turns 30 </dev/null
```
Pedido: "SOMENTE VERIFICAR NOMES. Não chame nenhuma ferramenta além de
ToolSearch. Passo 1: ToolSearch com query 'Supabase' e max_results 5. Passo 2:
uma chamada de ToolSearch por termo (query = termo, max_results 10): apply_migration,
deploy_edge_function, merge_branch, pause_project, create_project, execute_sql,
list_tables, create_deployment, request_promote, update_project, create_project_env,
put_firewall_config, list_projects, update_project_protection_bypass,
unpause_project, create_edge_function_secret. Depois responda apenas FIM."

## Leitura do resultado
Extrair, do fluxo `stream-json`, os `tool_reference` devolvidos pelo `ToolSearch`
e comparar as duas pastas. Conferir também que a **única** ferramenta chamada foi
`ToolSearch`. Resultado de 16/10/2026 em `RESULTADO-FASE-1.md`, seção 7.

## Limites
- A busca tem teto de resultados: uma ferramenta ausente numa busca isolada pode ser
  ruído; use a diferença entre as duas pastas, não a presença absoluta.
- `ENABLE_CLAUDEAI_MCP_SERVERS=true` foi o que fez a sessão não interativa carregar
  os conectores do claude.ai; não foi conferida na documentação oficial.
- Não prova que `ask` exija aprovação (ver J1–J13).
