# Fixture da protecao real (producao lida em 2026-11-18)

Origem: Supabase `ahattpqrjmhkzsmnbdzs` (producao), somente leitura.
Arquivos: `funcoes_prod.json` / `funcoes_prod.sql` (14 funcoes, definicao completa e md5),
`estruturas_prod.json` / `estruturas_prod.sql` (colunas, indice unico, extensoes), `verifica_funcoes.py`
(confere por assinatura, definicao e hash; `python3 verifica_funcoes.py`).

## Gatilhos carregados (exatamente estes dois, de producao)
- `trg_giro_limpar_marca` (casos, BEFORE UPDATE): zera a marca de giro ao trocar de dono. Afeta a
  fidelizacao, por isso entra.
- `trigger_impor_teto_operador` (casos, AFTER UPDATE): libera excedente de teto. Afeta a capacidade, por isso entra.

## Gatilhos de producao NAO carregados, com justificativa
Os nomes sao os de `estruturas_prod.json`. Criterio: entra quem altera responsavel, protecao,
capacidade, saldo, elegibilidade ou o resultado do rollback nos cenarios testados.

- `trg_guard_resp_aluno`, `trg_guard_resp_acordo` (alunos/acordos, guardas de responsavel):
  PODEM alterar o resultado. Em producao, escrita direta em responsavel e barrada. A fixture
  NAO reproduz essa barreira, e o teste p_terceiros.sql escreve responsavel diretamente para simular
  troca entre previa e execucao. Declarado como diferenca conhecida; o cenario de troca NAO
  prova a barreira de producao.
- `trg_aluno_segue_dono_do_acordo` (acordos): PODE alterar o responsavel do aluno quando um acordo
  e gravado. O cenario de acordo de p_protecao_real.sql grava acordos diretamente. Nao avaliado
  completamente; o resultado esperado (protecao) foi observado, mas o efeito colateral sobre o
  responsavel nao foi medido.
- `trg_sync_alunos_apos_casos` (casos): sincroniza alunos apos mudanca de casos; PODE mexer em
  responsavel_atual_em, que governa o hold de 24 h da liberacao. Nao reproduzido na fixture.
- `trg_acionamento_nao_volta_para_nulo`, `trg_alunos_retorno_origem`, `trg_aluno_reset_retorno_confirmado`
  (alunos): preservam acionamento e retorno. Copias equivalentes existem na base (dublê de
  bancada, declarado em `remanejamento_fidelizacao_prod_20261117.sql`), nao o original.
- `trg_titulo_*`, `trg_recalc_*`, `trg_acordo_*`, `trg_parcela_*` (acordos, titulos, parcelas):
  recalculam situacao e saldo. PODEM alterar o saldo que a protecao le. Os cenarios de quitacao
  gravam situacao e status diretamente. Nao reproduzidos.
- `trg_audit*`, `trg_efetividade_*`, `trg_zz_*`, `trg_nome_*`, `trg_atualizar_*`: auditoria,
  efetividade e normalizacao de nome. NAO alteram responsavel, protecao, capacidade ou o rollback.

## Copias que ainda existem na base (nao sao producao)
- `internal.set_resp_aluno`, `internal.set_resp_acordo`: copias de bancada (set_resp_* de
  `remanejamento_fidelizacao_prod_20261117.sql`). Mesma logica de troca de responsavel; diferem
  por nao passarem pela barreira de `trg_guard_resp_*`.
- `public.calibragem_saldo_aluno` (view): copia de bancada; producao a define de outra forma
  (ver `estruturas_prod.json`). Usada pelo calculo de saldo do remanejamento.
- `internal.patch_funcao_ancorada`: copia da migration 20260925181823 (helper de patch).
- auth: `auth.jwt()`, `auth.uid()`, `auth.role()`, `auth.email()` reproduzidos a partir da claim
  definida pelo teste (ver `remanejamento_pg17/auth_reproducao.sql`). Diferenca: o Supabase real
  le claims assinadas pelo gateway.

## Diferencas inevitaveis em relacao ao Supabase
- Extensao `unaccent`: em producao pertence a `supabase_admin`; no CI e criada pelo usuario de teste.
- Roles `anon`, `authenticated`, `service_role`: criadas no CI, sem os grants por defeito do Supabase.
- Tabelas: somente colunas e indice unico reproduzidos; sem RLS, sem policies, sem dados.
