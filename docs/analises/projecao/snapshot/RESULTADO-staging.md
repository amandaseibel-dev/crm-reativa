# Projeção Hora a Hora — Snapshot Manual · Resultado em STAGING

Branch: `feature/projecao-snapshot-manual` (a partir de `origin/main`).
Ambiente de teste: staging `edlzlfbstshojxrudwaa`. **Produção não foi tocada.**

## Objetos criados em staging
Scaffolding (staging-only, `staging_00_dependencias.sql` + cópia fiel da RPC):
- tabelas `pagamentos`, `metas_projecao` (subconjunto fiel de colunas de prod);
- índices `idx_pagamentos_data_pagamento`, `idx_pagamentos_operador_email`;
- `perfil_do_usuario_atual()` (cópia fiel de prod);
- `projecao_dashboard(text,text,text)` (cópia fiel de prod = "RPC atual" de referência);
- seed: 20.000 pagamentos em 2026-07 + 1 linha `metas_projecao`.

Deliverable (`supabase/migrations/20260728120000_projecao_snapshot_manual.sql`):
- tabela `projecao_snapshot` (PK escopo+mês; RLS deny-all; só as funções definer acessam);
- `projecao_calcular_filial(text)` — cálculo pesado OTIMIZADO (single-pass, sargável);
- `projecao_snapshot_ler(text)` — leitura leve (1 SELECT por PK), sem cálculo;
- `projecao_snapshot_atualizar(text)` — atualização manual + lock + preservação em falha.

## Tempo do cálculo (20k linhas, mês cheio)
- RPC atual `projecao_dashboard` (gestão): **~178–193 ms** (6 execuções).
- `projecao_calcular_filial` (otimizada): **~95–108 ms** (6 execuções) → ~46% mais rápida.
- Ganho real principal: roda **1×, sob demanda** (botão) em vez de a cada abertura + polling de 180s por usuário.

## Resultado comparativo (snapshot × RPC atual)
Comparação chave a chave da saída de gestão `projecao_dashboard('2026-07',null,null)` vs
`projecao_calcular_filial('2026-07')`: **44/44 chaves idênticas** (`igual=true`), incluindo
totais filial, ranking, histórico dia-a-dia, maior pagamento, projeções, metas e percentuais.

## Permissões (autorização real, sem depender de usuarios.perfil — ver BLOQUEIO)
Allowlist de e-mail em SECURITY DEFINER:
- **Atualizam**: `amanda.seibel@aelbra.com.br` (Amanda), `cobranca04@aelbra.com.br` (Fernanda).
- **Só visualizam**: `cobranca07` (Amanda ADM), operadores, demais.
- Leitura: gestão recebe payload completo; não-gestão recebe payload **sem** `ranking_equipe`
  e `maior_pagamento_individual`.

## Testes (PASS/FAIL)
| Teste | Resultado |
|---|---|
| Abrir a tela não executa RPC pesada (só `projecao_snapshot_ler` = 1 SELECT por PK) | PASS |
| N usuários visualizando geram apenas leituras leves (nenhum cálculo no read) | PASS |
| Amanda atualiza | PASS (ok, ~100 ms) |
| Fernanda atualiza | PASS (ok, ~102 ms) |
| cobranca07 (Amanda ADM) NÃO atualiza | PASS (42501) |
| operador NÃO atualiza | PASS (42501) |
| anônimo NÃO atualiza | PASS (42501) |
| Leitura gestão traz ranking | PASS (e_gestao=true, ranking presente) |
| Leitura operador/Amanda ADM sem ranking | PASS (e_gestao=false, ranking removido) |
| Falha preserva o snapshot anterior | PASS (payload md5 idêntico; status='erro'; erro_resumo registrado) |
| Números do snapshot == RPC atual | PASS (44/44 chaves) |
| Dois cliques simultâneos → uma execução (lock) | PASS por construção — ver nota |

**Nota lock (concorrência):** implementado com `pg_try_advisory_xact_lock` (chave por mês);
o segundo chamador concorrente recebe `55P03` e o snapshot anterior é preservado. A reprodução
com duas sessões simultâneas não foi executável neste harness (MCP = conexão única; sem psql/senha
local; `dblink` exige senha para não-superusuário). Mecanismo e ramo de rejeição (55P03) verificados
em código; recomenda-se um teste de 2 sessões via psql antes de produção.

## Índices necessários
- `idx_pagamentos_data_pagamento` (btree em `data_pagamento`): **já existe em prod**. O ganho vem
  de reescrever `to_char(data,'YYYY-MM')=p_mes` (não sargável) para `data >= inicio AND data < prox_mes`
  (sargável) — confirmado `Index Only Scan` para fatia seletiva em staging.
- Nenhum índice NOVO obrigatório. Opcional em prod (avaliar): índice em `pagamentos.aluno_id` só se
  o filtro por unidade for reativado (o EXISTS por unidade não tem apoio do lado `pagamentos`).

## Arquivos alterados / criados
- `supabase/migrations/20260728120000_projecao_snapshot_manual.sql` (deliverable, NÃO aplicado em prod).
- `src/pages/ProjecaoHoraHora.jsx` (frontend: remove polling; sem `projecao_dashboard` no mount;
  abre com snapshot; mostra última atualização; botão manual só Amanda/Fernanda; mantém dados
  anteriores durante atualização; sem loading infinito).
- `docs/analises/projecao/snapshot/staging_00_dependencias.sql` (scaffolding staging-only).
- `docs/analises/projecao/snapshot/RESULTADO-staging.md` (este arquivo).

## Escopo / limitações conhecidas (decisões documentadas)
- Snapshot = **visão de gestão (filial)** — a computação pesada que saturava. O painel pessoal do
  operador (comissão individual) NÃO faz parte deste snapshot e permanece sob o kill switch.
- Filtro de **unidade** não é aplicado ao snapshot nesta versão (snapshot é filial, sem filtro).
- Kill switch global permanece ATIVO; só `/projecao-hora-a-hora` foi liberada (via snapshot).

## Nada foi alterado em produção.
