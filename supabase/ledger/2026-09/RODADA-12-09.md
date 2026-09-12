> **Nota de 12/09/2026.** Este arquivo nasceu em `supabase/migrations/` como
> `LEIA-ME-20260912.md`. Agora vive no ledger, junto do SQL que descreve. Onde o texto
> diz "tem arquivo aqui", o arquivo esta em
> `supabase/ledger/2026-09/<version>__<nome>.sql` — **nao** em
> `supabase/migrations/`. Os caminhos `../aguardando_aprovacao/` passam a ser
> `../../aguardando_aprovacao/`.

# Migrations de 12/09/2026 — repo × produção: FECHADO

Quatorze migrations aplicadas em produção nesta data. **Nove são mudança de schema
e têm arquivo aqui. Cinco são execuções pontuais** (prova de dry-run, duas sondas
à API do Prime, amostra de portador, rodada do vigia) — não alteram estrutura e
não têm arquivo, de propósito.

| versão | nome | arquivo |
|---|---|---|
| 20260912000238 | fase2a_fluxo_acordos_assinatura_unica_e_permissao | ✅ |
| 20260912000256 | fase2a_prova_dryrun_assinatura_unica | execução pontual |
| 20260912000556 | fase2a_sonda_prime_espelho_vs_api | execução pontual |
| 20260912000856 | fase2a_sonda_prime_segunda_rodada | execução pontual |
| 20260912120756 | fase2b_amostra_portador_prime | execução pontual |
| 20260912121224 | fase2b_vinculo_pagamento_por_identificador_financeiro | ✅ |
| 20260912121605 | fase2b_consolida_duplicidade_e_origem_baixa | ✅ |
| 20260912121649 | fase2b_origem_baixa_no_gatilho_e_invariante_novo | ✅ |
| 20260912121656 | fase2b_executa_vigia_apos_invariante_novo | execução pontual |
| 20260912130752 | protecao_desliga_vinculo_por_negociacao_e_fecha_fluxo_pagamentos_rodar | ✅ |
| 20260912131004 | fila_sem_vinculo_rpc_gestao_com_motivo_financeiro | ✅ |
| 20260912131102 | origem_vinculo_prospectivo_em_pagamentos | ✅ |
| 20260912132259 | contador_da_fila_de_pagamento_sem_vinculo_no_cabecalho | ✅ |
| 20260912134610 | fecha_acordo_reconstruir_cron_orfa_e_sem_portao | ✅ |

## Conferência md5 produção × arquivo

Sem `supabase db pull`. Os arquivos foram gerados a partir de
`supabase_migrations.schema_migrations.statements` e conferidos por md5:

| arquivo | md5 (conteúdo sem newline final) | bytes |
|---|---|---|
| 20260912000238_fase2a_fluxo_acordos_assinatura_unica_e_permissao.sql | `e1d4f0897a5b2cc1edc4e01c21bd054b` | 10.247 |
| 20260912121224_fase2b_vinculo_pagamento_por_identificador_financeiro.sql | `d26718aae67461864a9730964abdd128` | 8.415 |
| 20260912121605_fase2b_consolida_duplicidade_e_origem_baixa.sql | `c5229f85dffa78161ddb2f085486c1db` | 7.863 |
| 20260912121649_fase2b_origem_baixa_no_gatilho_e_invariante_novo.sql | `81ea6a66bc5c719e0c27b69f83555be2` | 6.878 |
| 20260912130752_protecao_desliga_vinculo_por_negociacao_e_fecha_fluxo_pagamentos_rodar.sql | `d1366c34b0814af0253198ac86366a0e` | 5.748 |
| 20260912131004_fila_sem_vinculo_rpc_gestao_com_motivo_financeiro.sql | `228879b981fe6d8086abcd7c6190ef80` | 5.004 |
| 20260912131102_origem_vinculo_prospectivo_em_pagamentos.sql | `14fb0be2d41ac07cc43a825c31d4bae2` | 9.528 |
| 20260912132259_contador_da_fila_de_pagamento_sem_vinculo_no_cabecalho.sql | `09a49aceee50910d59c6ca915c5232d8` | 3.629 |
| 20260912134610_fecha_acordo_reconstruir_cron_orfa_e_sem_portao.sql | `43904c27f1fe3a686a2a057c22b19f6f` | 3.792 |

Os nove md5 são idênticos aos de produção. Drift nos dois sentidos: nenhum —
as nove versões aplicadas estão explicadas, e não há arquivo no repo sem versão
correspondente em produção.

## O que está preparado e NÃO foi executado

| arquivo | o que faz |
|---|---|
| `../aguardando_aprovacao/ROLLBACK_vinculo_por_identificador_financeiro.sql` | desfaz só o mecanismo novo de vínculo; não toca em `pagamentos`, na fila nem em `origem_baixa` |
| `../aguardando_aprovacao/MEDICAO_teste_importacao.sql` | 8 pontos de medição, 100% SELECT, para rodar antes e depois do primeiro teste real |
| `../aguardando_aprovacao/ROLLBACK_protecao_20260912.sql` | religa a etapa `vinculo_por_negociacao`; blocos 2 e 3 (reabrir a RPC, voltar a fila antiga) vêm comentados de propósito |
| `../aguardando_aprovacao/MEDICAO_canario_por_lote.sql` | 11 pontos de medição atribuídos ao `importacao_id` do canário |
| `../aguardando_aprovacao/ROLLBACK_excecao_conciliacao_3_casos.sql` | desfaz o `nao_acionar` dos 3 casos em quarentena |
| `../aguardando_aprovacao/20260912001000_caso_faltando_para_aluno_com_divida.sql.pendente` | CONSERTO 3, fora do caminho de apply |

## Baseline medida em 12/09/2026 13:05 UTC (antes do teste)

| ponto | valor |
|---|---|
| pagamentos | 8.999 — digest `b72aa40d7a9775d29d1bf501fe0ed091` |
| pagamentos com `aluno_id` / sem | 8.944 / 55 |
| `fila_pagamento_sem_vinculo` | 0 linhas |
| parcelas PAGO | 4.430 — digest `e034bab4a3ccb204370f0f7baf40ac6c` |
| parcelas com `origem_baixa` | 0 (o campo é prospectivo) |
| `baixas_pagamento` | 3.319 |
| `suspeitas_pagamento_duplicado` | 29 (12 LEGITIMO + 17 PENDENTE_VALIDACAO) |
| `sum(alunos.saldo_total)` | R$ 45.204.104,20 — digest `209bba0dcf2ae21c3cdea00727df0364` |
| casos | 18.424, sendo 13.234 não encerrados — digest `6898e509930a7b6c97fb86d20808a298` |
| `sum(casos.saldo_total)` | R$ 46.630.865,67 |

## Etapa de proteção de 12/09/2026, 13:07 UTC

| Ato | Antes | Depois |
|---|---|---|
| `fluxo_pagamentos_config` etapa `vinculo_por_negociacao` | `ligado = true` (desde 09/09, `migration_09_09_2026`) | **`ligado = false`**, estado anterior gravado na própria `observacao` + linha em `auditoria` (`DESLIGOU_ETAPA_FLUXO`) |
| `fluxo_pagamentos_rodar(text)` | `EXECUTE` para `authenticated` | revogado de `public`, `anon`, `authenticated`; dono (`postgres`) preservado |
| `pagamentos_sem_aluno` | `EXECUTE` para `authenticated`, **sem portão interno** | `EXECUTE` para `authenticated` + portão `usuario_e_gestao()` dentro da função |
| `pagamentos.origem_vinculo` | não existia | 3 colunas + CHECK de 6 valores; **0 linhas históricas preenchidas** |
| `acordo_reconstruir_cron()` | `EXECUTE` para `authenticated`, **sem portão**, órfã (nenhum cron a usa) | revogado de `public`, `anon`, `authenticated`; dono e `service_role` preservados. Nunca executada |

As outras quatro etapas do fluxo (`amarrar_boleto`, `pos_importacao`,
`baixa_pelo_relatorio`, `sinalizar_duplicado`) seguem ligadas, por ordem da
gestão.

### Prova na rodada seguinte do cron — 12/09/2026 13:40:00 UTC

`cron.job_run_details`: `succeeded`, 17,18s, sem erro. `fluxo_pagamentos_execucoes`:

| Rodada | Etapas no `resultado` | `vinculo_por_negociacao` |
|---|---|---|
| 12:40 (antes) | amarrar_boleto, baixa_pelo_relatorio, baixa_previa, duplicados, pos_importacao, **vinculo_por_negociacao** | presente |
| 13:40 (depois) | amarrar_boleto, baixa_pelo_relatorio, baixa_previa, duplicados, pos_importacao | **ausente** |

Corroboração independente, medida às 13:42:

| | Antes das 13:40 | Depois | |
|---|---|---|---|
| vínculos `EXATO_PRIME_195` | 270 | 270 | igual |
| vínculos totais | 4.657 | 4.657 | igual |
| último vínculo criado | 12/09 04:40 | 12/09 04:40 | nenhum novo |
| tabelas `_backup_vinc_negociacao_%` | 81 | 81 | a rotina nem foi chamada — ela cria o backup antes de qualquer decisão |
| `sum(alunos.saldo_total)` | 45.204.104,20 | 45.204.104,20 | igual |

`carteira_antes` e `carteira_depois` da própria execução das 13:40 também são
iguais: R$ 45.204.104,20.

## Reconferência

```sql
select version, name, md5(array_to_string(statements, E'\n')) as md5_prod
  from supabase_migrations.schema_migrations
 where version >= '20260912000000' order by version;
```

```bash
cd supabase/migrations
perl -0pe 's/\n\z//' <arquivo>.sql | md5 -q
```
