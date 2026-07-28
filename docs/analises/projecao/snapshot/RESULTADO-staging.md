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

**Teste de concorrência REAL (2 backends) — PASS.** Reproduzido com dois backends independentes:
um *background worker* do `pg_cron` (extensão instalada só para o teste e removida ao final)
segurou o lock do updater e ficou processando (simulando a atualização de Fernanda em andamento);
durante esse processamento, disparei o updater REAL como **Amanda** e como **Fernanda** no meu backend.
Resultado:
- holder detectado em backend separado (pid 375234), processando;
- Amanda → **55P03** "Ja existe uma atualizacao em andamento para 2026-07";
- Fernanda → **55P03** (mesma mensagem);
- **cálculos executados = 1** (só o holder concluiu); as 2 chamadas simultâneas executaram **0**;
- snapshot íntegro ao final (status=ok, ranking presente, honorário filial correto);
- após concluir, Amanda e operador leem o **mesmo** snapshot (mesmo `atualizado_em`).
Sem senha/token/JWT registrados; scaffolding (`pg_cron`, funções `_test_*`) removido — sem locks pendentes.

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

## Decisão de visualização (implementada no frontend)
- **Amanda / Fernanda** (backend `e_gestao=true`): visualizam tudo (filial + ranking + por operador)
  e têm o botão "Atualizar projeção".
- **Amanda ADM / operadores** (`e_gestao=false`): visualizam o snapshot da **filial** (totais +
  evolução dia-a-dia). Ocultos: `ranking_equipe`, `maior_pagamento` e dados individuais de outros
  operadores (drill-down por dia desabilitado; painel pessoal da Amanda ADM removido nesta release).
  **Sem** botão de atualização.
- Abertura da página faz **1 leitura leve** (`projecao_snapshot_ler` = Index Scan por PK, ~0.05 ms);
  nunca executa cálculo pesado nem `projecao_dashboard`.
- Verificado: só `/projecao-hora-a-hora` usa as novas RPCs; kill switch global segue `true`; demais
  telas (Carteira, MeuDashboard, TV, etc.) continuam suspensas por `analiticasSuspensas()`.

## Build / testes
- `npm run build`: **PASS** (406 módulos; só o warning pré-existente de tamanho de chunk).
- `npm run test` (vitest): **PASS** (35/35).
- Lint da página: 2 erros **pré-existentes** (`ano` linha 21, `set-state-in-effect` linha ~245),
  ambos já presentes em `origin/main` e não introduzidos por esta mudança. Nenhum erro novo.

## Escopo / limitações conhecidas (decisões documentadas)
- Snapshot = **visão de gestão (filial)** — a computação pesada que saturava. O painel pessoal do
  operador/Amanda ADM (comissão individual) NÃO faz parte deste snapshot e permanece sob o kill switch.
- Filtro de **unidade** não é aplicado ao snapshot nesta versão (snapshot é filial, sem filtro).
- Kill switch global permanece ATIVO; só `/projecao-hora-a-hora` foi liberada (via snapshot).

## Nada foi alterado em produção.
