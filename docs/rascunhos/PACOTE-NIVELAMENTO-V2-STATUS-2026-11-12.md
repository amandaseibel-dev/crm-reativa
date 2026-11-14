# Pacote do nivelamento V2 — estado real (12/11/2026)

Projeto de produção: `ahattpqrjmhkzsmnbdzs`. **Nada aplicado. Nenhuma redistribuição. Nenhum commit, nenhum push.**

## Arquivos preparados (não aplicados)

- `supabase/aguardando_aprovacao/nivelamento_carteiras_v2.sql.pendente`: ocupação, saldo em centavos (via `aluno_saldo_pendente_detalhe`), elegibilidade, distribuição (`nivelamento_distribuir`) e troca no teto (`nivelamento_assumir_com_troca`).
- `supabase/aguardando_aprovacao/onda1_gate_somente_gestao.sql.pendente`: troca do gate `calibragem_e_gestao() or auth.jwt() is null` por `calibragem_e_gestao()` em `onda1_conferir`, `onda1_executar` e `onda1_reverter`. Substituição ancorada: aborta se a âncora não ocorrer exatamente uma vez. Verificado em produção: cada uma das três tem exatamente 1 ocorrência.

## Simulação somente leitura (dados de 12/11)

| Operador | Ocupação | Acionáveis | Teto | Bloqueado para distribuição |
|---|---:|---:|---:|---|
| cobranca06 | 941 | 601 | 700 | sim |
| cobranca08 | 915 | 568 | 700 | sim |
| cobranca11 | 910 | 571 | 700 | sim |
| cobranca10 | 899 | 542 | 700 | sim |
| cobranca05 | 887 | 532 | 700 | sim |
| cobranca13 | 883 | 554 | 700 | sim |
| cobranca12 | 881 | 542 | 700 | sim |
| carteira.geral (reserva) | 144 | 49 | — | não se aplica (fora do teto) |

**Resultado esperado da distribuição automática hoje: 0 movimentações**, porque nenhum operador de cobrança tem vaga. A carteira geral pode fornecer casos, mas não há destino com vaga.

## Itens que NÃO estão prontos

1. **Reposição por pagamento não foi implementada.** A regra é: só baixa `REALIZADA` (`baixas_pagamento.status_baixa`, 3.610 registros) libera reposição, uma vez por baixa, e só se a ocupação ficar abaixo do teto após a baixa. A função atual `nivelamento_distribuir` distribui casos livres sem exigir baixa. Isso precisa ser separado: distribuição de caso livre (sem reposição) versus reposição (com baixa).
2. **Testes SQL não foram escritos nem executados.** Não há Postgres local nem harness com stubs de `auth.jwt()`, `caso_protegido_redistribuicao` e demais dependências. O PGlite existe em `node_modules`, mas não reproduz o schema do Supabase.
3. **CI não foi executado.** Depende de código commitado e de push, que não foram feitos.
4. **Rollback não foi escrito.** Para o gate, o rollback é recolocar a expressão original (uma linha por função). Para as novas funções, é `drop function`. Para o nivelamento aplicado, precisa de um plano de compensação por `calibragem_auditoria`.
5. **Outras funções com o mesmo gate.** `calibragem_efetividade`, `calibragem_sem_tabulacao`, `calibragem_snapshot_visao_operador`, `calibragem_simular` e `calibragem_executor_transacional` têm `or auth.jwt() is null`. Não foram alteradas: fora do escopo da Onda 1, e precisam de análise de chamadores.
6. **Integração com a tela "assumir atendimento".** `nivelamento_assumir_com_troca` existe, mas a RPC atual `assumir_caso_livre` ainda não chama a troca.
7. **Desempenho.** `nivelamento_saldo_caso_centavos` chama `aluno_saldo_pendente_detalhe` por caso, e a seleção de saída faz isso para todos os casos do operador. Precisa de medição antes de rodar em lote.

## Decisões que ainda dependem de você

- Confirmar que pode haver distribuição de caso livre sem reposição (item 1), ou se toda entrada deve esperar baixa.
- Confirmar a frequência do job: a proposta é diária, às 09:20, depois do `nivelamento_automatico_gestao` atual, que precisa ser substituído ou desligado para não haver dois mecanismos.

## Próximos passos (quando autorizados)

1. Separar reposição de distribuição e implementar a reposição com baixa `REALIZADA`.
2. Escrever os testes (operador abaixo, no teto e acima; negociação sem reposição; baixa com reposição única; troca de mesmo saldo; sem par; proteção; concorrência; movimentações vinculadas; recusas do gate).
3. Rodar CI no commit final. Só com autorização de push.
4. Pacote único para aprovação de implantação.
