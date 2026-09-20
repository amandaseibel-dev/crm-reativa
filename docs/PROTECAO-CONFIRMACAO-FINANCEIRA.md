# Proteção de confirmação financeira aberta (aluno com confirmação de pagamento pendente)

**Estado (20/09/2026):** migration **aplicada em produção** às 16:38:28 UTC (versão registrada `20260920163828`, arquivo de origem `20260920140000_protecao_confirmacao_financeira_por_aluno`, ledger em `supabase/ledger/2026-09/`); front (Fila Operacional) em deploy pelo PR desta correção. Rollback em `supabase/rollbacks/`.

## O problema (medido em produção)
Das 351 solicitações abertas (`AGUARDANDO_CONFIRMACAO` 345 + `PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO` 6),
**345 têm `aluno_cpf` nulo** e **todas têm `aluno_id`**. A proteção de redistribuição comparava
`solicitacoes.aluno_cpf = cpf do caso` e só olhava um dos dois estados: nunca casava.
Exposição comprovada: Fila Operacional 140 casos, `assumir_caso_livre(_aluno)` 5, reposição 5 (cron desligado).

## O que muda
| Onde | Mudança |
|---|---|
| `caso_protegido_redistribuicao` | +1 bloco: aluno pelo CPF normalizado da ficha, solicitação por `aluno_id`, os dois estados abertos. Nada removido. |
| `nivelamento_automatico_gestao` | o teste por `aluno_cpf` vira `aluno_id` do caso, com os dois estados. Resto byte a byte. |
| `FilaOperacional.jsx` | consulta o RPC `alunos_em_confirmacao_pendente()`; quem está no conjunto vai para o grupo "fora da cobrança" com selo "Aguardando confirmação de pagamento". **Fail-closed**: sem o RPC, mostra erro e não lista a fila. |

Não altera saldo, parcelas, acordos, pagamentos, confirmações, responsável, fidelização, retorno, agenda,
Prime, Links, Ações Massivas, Minha Carteira, os 18 pagamentos sem aluno nem o cron de reposição.

## Efeitos colaterais assumidos (mesmo desenho já usado para a Conferência Prime)
Como a regra central agora enxerga a confirmação, **15 casos** passam a ser "protegidos", 10 com operador
(5 operadores, no máximo 4 por operador). Consequências, todas por desenho:
- não contam como vaga na reposição, no teto (`trg_impor_teto_operador`) e no nivelamento;
- não são soltos pela fidelização (`casos_elegiveis_liberacao_fidelizacao`);
- saem do card/lista "risco de perder" (`casos_risco_perder`, usado por Minha Carteira) — o código de
  Minha Carteira não muda, mas esse RPC devolve até 10 casos a menos.

## Ponto conhecido e NÃO tratado nesta etapa: a ficha
Tirar o caso da Fila Operacional **não bloqueia** o operador de abrir a ficha por outro caminho
(rota `/aluno?alunoId=…`, aberta a partir de CRM/busca, CasosSemTelefone, MensalidadesAVincular,
MinhaFilaQuitacao, PainelAdm, ProjecaoHoraHora, links do WhatsApp) nem de tabular lá dentro:
- `Aluno.jsx` e `finalizarAtendimento` (FilaOperacional) **não** consultam confirmação aberta antes de registrar;
- `ConfirmarPagamento` só impede uma SEGUNDA solicitação;
- só o modal de Minha Carteira (`PainelCarteira`) esconde o formulário de tabulação quando há confirmação aberta.
**Não implementar trava na ficha sem nova autorização.**

## Checklist de validação pós-deploy (na ordem)
### Banco (logo após aplicar a migration)
1. `md5(prosrc)` de `caso_protegido_redistribuicao` e `nivelamento_automatico_gestao` **diferem** dos hashes antigos
   (`11caab2c…` e `af551b61…`) e batem com os do arquivo aplicado. Hashes de `assumir_caso_livre`, `assumir_caso_livre_aluno`,
   `reposicao_carteira_processar`, `trg_repor_caso_operador`, `acoes_massivas_universo` e `alunos_em_confirmacao_pendente` **iguais** aos de antes.
2. Cron `reposicao_carteira_minuto` continua `active=false`; `reposicao_carteira_fila` com 54 pendentes (não processados).
3. Leitura (sem escrever): os 320 casos com solicitação aberta → 320 protegidos; assumíveis 5→0; elegíveis à reposição 5→0.
4. Hash de `alunos`, `casos`, `parcelas`, `acordos`, `acordos_titulos`, `solicitacoes_confirmacao_pagamento`, `pagamentos`
   igual ao de antes da migration (a migration só toca funções).
5. Log/histórico: nenhuma linha nova `LIBERACAO_AUTOMATICA_CASO_FECHADO`, `REPOSICAO_AUTOMATICA_VAGA` ou `NIVELAMENTO_AUTOMATICO_GESTAO`
   causada pela migration; conferir também a execução das 09:20 do nivelamento (esperado: nada movido dos casos com confirmação).
### Front (depois do deploy)
6. Fila Operacional, filtro "Minha fila": nenhum aluno com confirmação aberta aparece entre os acionáveis; eles vêm no fim,
   com o selo "Aguardando confirmação de pagamento" e o aviso "não acionar". Repetir em "Sem responsável" e na busca por nome/CPF.
7. **Fail-closed:** bloquear/quebrar o RPC `alunos_em_confirmacao_pendente` num ambiente de teste (ou negar o EXECUTE) e conferir a
   mensagem "Não foi possível verificar os alunos com confirmação de pagamento pendente…" e a fila **vazia** (nunca a fila sem proteção).
8. Minha Carteira: continua sem listar/acionar quem tem confirmação aberta; conferir que o card "risco de perder" caiu em no máximo 10 casos no total.
9. Ações Massivas: prévia de um lote com filtro amplo — `confirmacao_pendente` continua listado como motivo, cobertura e contagens iguais às de antes.
### Amanhã, manualmente (ficha)
10. Abrir por CADA caminho listado acima um aluno com confirmação aberta e anotar se abre a ficha.
11. Dentro da ficha, tentar registrar tabulação/cobrança: anotar se o sistema deixa (esperado hoje: deixa, exceto no modal de Minha Carteira).
12. Levar o resultado à Amanda para decidir a trava na ficha (item fora do escopo desta entrega).

## Rollback
`supabase/rollbacks/20260920140000_protecao_confirmacao_financeira_por_aluno.rollback.sql` restaura exatamente as duas definições de produção
(`md5(pg_get_functiondef)` conferido: `c497631ffeec5e06bce6ddcc974af48b` e `7ae72fea9af90386aee288c189f9f12a`). Front: reverter o commit.

# Decisões e débitos registrados nesta frente

## Vínculo de pagamento: `PREFIXO_UNICO` e `NUMERO_ULBRA_UNICO` como vínculo seguro (decisão de 20/09/2026)

**Decisão da Amanda:** no FUTURO, `PREFIXO_UNICO` e `NUMERO_ULBRA_UNICO` poderão ser tratados como vínculo seguro
para a proteção "pagamento recebido pendente". **Não implementado.**
Evidência (leitura em produção, 20/09/2026): 69 + 3 vínculos, 72/72 com a parcela baixada no MESMO aluno
(confirmação posterior por boleto exato), 0 ambiguidade hoje, 0 troca posterior de `aluno_id` em `audit_log`.
Fonte da regra: `_pagamento_vincula_por_identificador_financeiro` (unicidade por acordo; dois candidatos → `SEM_VINCULO`).
Ressalva: amostra de 30 dias; 17 `numero_ulbra` aparecem em mais de um acordo (todos do mesmo aluno) e por isso caem em `SEM_VINCULO`.

## Débito: ramo CPF do vínculo de pagamento (aberto em 20/09/2026)

`_pagamento_vincula_por_identificador_financeiro` resolve o aluno por CPF com `limit 1` **sem ordenação**, e existem
**24 CPFs com mais de um aluno** (50 fichas). Hoje o ramo nunca produziu vínculo (0 pagamentos com `origem_vinculo='CPF'`,
porque o arquivo Santander não traz CPF), então não há dano. Se o arquivo passar a trazer CPF, o vínculo pode cair na ficha errada.
**Não corrigir agora; investigar antes de qualquer mudança.**

## Débito: funções que existem só em produção (sem migration no repo)

`alunos_em_confirmacao_pendente`, `aluno_em_confirmacao_pagamento`, `reposicao_carteira_processar`, `trg_repor_caso_operador`,
`fila_casos_sem_responsavel`. A Fila Operacional passa a depender do RPC `alunos_em_confirmacao_pendente` (SECURITY DEFINER,
STABLE, executável por `authenticated`); versionar a definição real antes de qualquer mudança nele.

## Débito: `aluno_cpf` nulo em solicitações de confirmação

345 das 351 solicitações abertas (3.935 de 9.416 no total) têm `aluno_cpf` nulo. Nesta frente as regras passaram a usar `aluno_id`;
o preenchimento retroativo do campo **não** foi feito e continua sendo outra frente.

## Ficha do aluno não bloqueia aluno com confirmação aberta

Ver `docs/PROTECAO-CONFIRMACAO-FINANCEIRA.md`. Verificar amanhã, manualmente, os caminhos que abrem a ficha e se a tabulação é possível;
trava adicional só com nova autorização.
