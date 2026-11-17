# Procedimento operacional — reversao de 20261113100000 / 20261113100100

**Status: PROPOSTA. Nao executado. Exige autorizacao da gestao antes de qualquer uso.**

## Garantias que o banco impoe (verificadas no estado efetivo)
- `SET LOCAL lock_timeout = '5s'` por transacao: se a trava de `acoes_massivas_lotes` nao for obtida em 5 s, a transacao aborta sem alterar nada.
- Trava `SHARE ROW EXCLUSIVE` em `acoes_massivas_lotes` antes da checagem de pendentes: serializa com qualquer insercao de lote (`ROW EXCLUSIVE`).
- Recusa se houver **sessao em andamento** executando a exportacao (`pg_stat_activity`, estado diferente de `idle`), e se houver lote pendente (`confirmado_em` e `descartado_em` nulos).
- Recusa antes de qualquer DROP ou patch; `BEGIN`/`COMMIT` garantem tudo-ou-nada.

## Janela residual e como fecha-la (honesto)
`lock_timeout` limita a espera; **nao resolve sozinho** uma exportacao em andamento. O caso critico e:
1. uma exportacao comeca **antes** da reversao, com o corpo antigo;
2. ela chega ao `INSERT` depois da checagem e fica bloqueada pela trava;
3. a reversao confirma; a exportacao insere um lote **pendente depois** da checagem.

Mitigacao no banco: a guarda de sessao ativa **detecta** a exportacao iniciada antes e recusa a reversao. Uma exportacao que comece **depois** da checagem e antes do COMMIT nao e vista pela guarda; por isso a pausa abaixo e obrigatoria.

## Passos (operacionais, pendentes de autorizacao)
1. **Backup** do banco antes da janela (PITR nao habilitado; premissa §13).
2. **Pausar novas chamadas:** remover temporariamente o EXECUTE de `authenticated` nas funcoes `acoes_massivas_exportar` e `acoes_massivas_exportar_emails_do_lote` (ou publicar front sem o botao). Acao externa; registrar quem autorizou.
3. **Confirmar o termino das existentes:** `select pid, state, left(query,120) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and query ilike '%acoes_massivas_exportar%';` — deve retornar **zero linhas** por pelo menos um intervalo de observacao acordado.
4. **Contagem momentanea de pendentes por canal** (evidencia, nao substitui a guarda):
   `select now(), canal, count(*) from public.acoes_massivas_lotes where confirmado_em is null and descartado_em is null group by canal;`
5. **Reverter na ordem:** `20261113100000` rollback, depois `20261113100100` rollback. Cada um recusa sozinho se a condicao faltar.
6. **Verificacao pos-COMMIT:** repetir a contagem do passo 4 (esperado: zero) e conferir os md5 das duas funcoes (`c9cc7498…` e `00d3370a…`).
7. **Restaurar o EXECUTE** do passo 2 somente depois da verificacao do passo 6.

## Se o passo 6 encontrar pendente
Nao reexecutar nada. Tratar o lote pendente pela operacao (tabular ou descartar) e registrar a ocorrencia; a reversao da protecao continua recusada enquanto houver pendente.

## Testes
- Local (PGlite): `supabase/tests/acoes_massivas_ordem_aplicacao.test.js` (43 casos entre as suites de banco) — logica e preservacao.
- **Concorrencia (duas conexoes):** `scripts/ci/teste-reversao-concorrencia.sh` — **nao executado** (sem PostgreSQL no ambiente local). Requer banco de teste.
