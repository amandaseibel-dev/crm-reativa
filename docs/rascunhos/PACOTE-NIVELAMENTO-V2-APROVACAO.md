# Pacote de aprovação — Nivelamento V2 (PR #916)

**Status: PREPARADO e TESTADO EM POSTGRES (PGlite local). CI do commit final: pendente. NÃO mesclado. NÃO aplicado em produção.**

Branch `feat/nivelamento-v2`. Commit atual: ver `git log -1`.

## Artefatos e SHA-256 (16 primeiros hex)

| Artefato | SHA-256 |
|---|---|
| `supabase/aguardando_aprovacao/20261112120000_nivelamento_v2.sql.pendente` | 41610d8161b65005 |
| `supabase/aguardando_aprovacao/20261112120100_calibragem_gate_somente_gestao.sql.pendente` | 945b57ec16b3f472 |
| `supabase/aguardando_aprovacao/20261112120000_nivelamento_v2.rollback.sql` | 464946fa5a8d7dd4 |
| `supabase/aguardando_aprovacao/20261112120100_calibragem_gate_somente_gestao.rollback.sql` | b6042c3efd0843e7 |
| `supabase/tests/nivelamento_v2/01_ambiente.sql` | 66d64b67312b509f |
| `supabase/tests/nivelamento_v2/02_casos.sql` | 673a3859bddec633 |
| `supabase/tests/nivelamento_v2/03_concorrencia_setup.sql` | 096a3b516578e0e6 |
| `supabase/tests/nivelamento_v2/04_pos_rollback.sql` | 4ef1fde3f4f431dc |
| `supabase/tests/nivelamento_v2/05_gate.sql` | d1f38d177bdd5f9c |
| `supabase/tests/nivelamento_v2/06_pos_rollback_gate.sql` | 8a266acd8ada3ad6 |

Hash comprova identidade do código, **não** equivalência de comportamento dos stubs.

## Regras implementadas

1. Entrada automática = só reposição por baixa `REALIZADA`, com capacidade abaixo de 700 (teto).
2. Chave de idempotência = **link de pagamento** (`solicitacao_link_id`) ou id da baixa. Pagamentos distintos com mesmo cpf/valor/dia **não** são suprimidos (teste 5b).
3. Mesmo link = um pagamento (teste 5).
4. Baixa recebida com operador no teto → `REPOSICAO_V2_SEM_VAGA`, **sem crédito**: quando a vaga abrir, nada é gerado (teste 6b).
5. Negociação/acordo não libera vaga; ocupação conta acordo e negociação.
6. Troca no teto por caso de mesmo saldo cobrável (centavos, referência da ficha/cobrança), em transação, duas movimentações vinculadas por `troca_id`. Sem par: `sucesso=false`, nada alterado.
7. Gate: gestão por JWT, **ou** `auth.jwt() is null AND session_user IN ('postgres','reativa_responsavel_executor')`. JWT ausente sozinho nunca autoriza.
8. Gate das simulações (`calibragem_simular`, `calibragem_simular_ano`, `calibragem_recomputar_snapshot`): removida a forma "sem JWT + sessão privilegiada" (teste 8b).

## Permissões efetivas (lidas em produção, somente leitura)

- `reativa_responsavel_executor`: NOLOGIN, BYPASSRLS. Membro de `postgres`. Só alcançável por sessão `postgres`.
- `postgres`: LOGIN, BYPASSRLS, membro de `anon`, `authenticated`, `service_role`, `authenticator`, `reativa_responsavel_executor`, `readonly_auditoria`.
- Exposição concreta encontrada: sessão `postgres` sem JWT (SQL direto, conector MCP) executava as simulações sem pessoa identificada. Fechada no item 8. Os grants `authenticated` continuam, mas o gate recusa operadores sem gestão.

## Ordem de implantação (quando autorizada)

1. Confirmar backup lógico do estado atual (funções `assumir_caso_livre`, as 3 simulações, as 5 `calibragem_*`/`onda1_*` alteradas, job 48).
2. Aplicar `20261112120000_nivelamento_v2.sql.pendente` (grava `nivelamento_v2_backup`, corte `nivelamento_v2_desde = now()`, desativa job 48, agenda `nivelamento_v2_reposicao` a cada hora no minuto 7).
3. Aplicar `20261112120100_calibragem_gate_somente_gestao.sql.pendente` (fecha o gate).
4. Verificar: job 48 inativo, job V2 agendado, `assumir_caso_livre` com ACL `postgres/authenticated/service_role` (sem PUBLIC/anon), gate das simulações recusa sessão sem JWT.

## Troca dos jobs

- Antes: `nivelamento_automatico_gestao` (jobid 48, `20 9 * * *`, `select public.nivelamento_automatico_gestao(10, true)`).
- Depois: `nivelamento_v2_reposicao` (`7 * * * *`, `select public.nivelamento_reposicao_por_baixas(200)`). Job 48 desativado.

## Reversão

- **Principal** (`20261112120000_nivelamento_v2.rollback.sql`): restaura `assumir_caso_livre` (definição e grants anteriores: EXECUTE só `authenticated` e `service_role`), reagenda o job antigo com mesmo **nome, agendamento e comando** (o **jobid muda**), remove funções/índices V2, remove o corte. **Não reabre o gate.** Não apaga linhas de `calibragem_auditoria` (append-only).
- **Gate** (`20261112120100_calibragem_gate_somente_gestao.rollback.sql`): **reabre a brecha** — restaura a definição anterior das funções alteradas, inclusive "or auth.jwt() is null". Executar só com decisão expressa.

## Simulação com dados atuais

Ver `docs/rascunhos/PACOTE-NIVELAMENTO-V2-STATUS-2026-11-12.md`: 7 operadores de cobrança acima de 700 (881–941); carteira geral fora do teto. **Resultado esperado: zero movimentações** na primeira rodada.

## Pendências declaradas

- **Integração com dependências reais de produção:** não executada. As funções-dependência (`caso_protegido_redistribuicao`, `aluno_saldo_pendente_detalhe` etc.) são stubs no CI. Validação em ambiente isolado com definições de produção exige export das definições e cadeia completa de dependências — não concluída.
- CI do commit final: pendente no momento deste documento.
- Não há merge nem aplicação em produção nesta preparação.
