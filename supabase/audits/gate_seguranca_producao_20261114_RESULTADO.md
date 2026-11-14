# Auditoria de segurança em produção — saída medida (14/11/2026)

**Consulta:** `supabase/audits/gate_seguranca_producao_20261114.sql` (somente leitura: só `SELECT`).
**Projeto:** `ahattpqrjmhkzsmnbdzs` (produção). **Via:** conector de banco, papel `postgres`, sem DML.
**Não é a execução do `run_security_gate.sh`** — esse script não roda aqui (`psql` ausente) e falha no Postgres por defeito próprio (ORDER BY sobre UNION; com erro ele imprime "SQL OK" e sai com código 0).

## Resultado

| Gravidade | Check | Quantos | Objetos |
|---|---|---|---|
| BLOQUEIA | BUCKET_PUBLICO | 1 | `tv-imagens` |
| BLOQUEIA | TABELA_SEM_RLS | 1 | `_tmp_fila2` |
| BLOQUEIA | VIEW_BYPASS_RLS | 5 | `vw_extracao_calibragem`, `vw_extracao_observabilidade`, `vw_extracao_validacao_trilha`, `vw_pagamento_suspeita_pendente`, `vw_titulo_presenca_historico` |
| ALERTA | POLICY_AMPLA | 21 | (21 itens) |
| ALERTA | RLS_SEM_POLICY_COM_GRANT | 1073 | (1073 itens) |
| ALERTA | RPC_SECDEF_EXECUTE_ANON | 24 | (24 itens) |
| ALERTA | GRANT_ANON_ESCRITA | 0 | (nenhum grant de escrita a `anon` nas 10 tabelas listadas) |
| ALERTA | TABELA_SEM_RLS | 5 | `_backup_dua_massiva_setembro_20261020`, `_backup_dua_massiva_setembro_20261020_casos`, `_backup_residuo_massiva_0210_alunos_20261005`, `_backup_residuo_massiva_0210_casos_20261005`, `saude_carteira_mv_meta` |

## Leitura

- **Reprova pela regra do gate:** há 7 itens `BLOQUEIA`. Esta PR não cria nenhum dos objetos listados: o diff não contém DDL sobre eles.
- **Não comprovado:** se algum `BLOQUEIA` já é exceção aceita. Não há exceção versionada em `docs/seguranca/` para eles.
- Esta saída registra o que foi medido em 14/11. Números mudam com a base.
