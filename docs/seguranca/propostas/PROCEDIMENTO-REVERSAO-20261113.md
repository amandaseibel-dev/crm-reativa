# Procedimento operacional — reversao de 20261113100000 / 20261113100100

**Status: PROPOSTA. Nao executado. Nao autorizado. Exige autorizacao expressa da gestao antes de qualquer uso.**

## O que os rollbacks garantem (no banco)
- `SET LOCAL lock_timeout = '5s'` na transacao: se a trava de `acoes_massivas_lotes` nao for obtida em 5 s, a transacao aborta sem alterar nada.
- `LOCK TABLE ... IN SHARE ROW EXCLUSIVE MODE` antes da checagem: serializa com qualquer insercao de lote (`ROW EXCLUSIVE`) que ja esteja em curso.
- Recusa se houver **qualquer lote pendente** (`confirmado_em` e `descartado_em` nulos), checado depois da trava.
- Recusa antes de qualquer DROP ou patch; `BEGIN`/`COMMIT` garantem tudo-ou-nada.

**O que NAO garantem:** nao ha guarda que identifique, por consulta a `pg_stat_activity`, uma exportacao em andamento. Tentamos e removemos: detecta por texto e nao foi testada. A protecao contra exportacao em andamento e **operacional** (pausa abaixo).

## Residual (honesto)
Uma exportacao que **comece depois da checagem e antes do COMMIT** nao e vista pelo banco. Se ela inserir lote pendente depois da checagem, o rollback ja terminou; o lote fica pendente e a protecao de e-mail ja foi revertida. Por isso a pausa e obrigatoria e a verificacao pos-COMMIT (passo 6) e necessaria.

## Passos (operacionais; cada um depende de autorizacao)
1. **Backup** do banco antes da janela. PITR nao esta confirmado como habilitado: confirmar antes.
2. **Pausar novas chamadas**, em todos os caminhos de execucao, nao so no front:
   - revogar EXECUTE de `authenticated` em `acoes_massivas_exportar` e `acoes_massivas_exportar_emails_do_lote` durante a janela;
   - verificar e pausar tambem `service_role`, cron e edge functions que chamem essas funcoes (inventario a fazer; nao conferido);
   - publicar o front sem o botao, se houver risco de chamada direta.
3. **Confirmar o termino das existentes** (consulta somente leitura, repetida ate zero linhas por um intervalo de observacao definido pela gestao):
   `select pid, state, left(query,120) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and query ilike '%acoes_massivas_exportar%';`
   Sessao `idle in transaction` com essa query **tambem conta como pendencia**: encerrar com autorizacao, nunca por conta propria.
4. **Contagem momentanea de pendentes por canal, com data e hora** (evidencia; nao substitui a checagem do rollback):
   `select now(), canal, count(*) from public.acoes_massivas_lotes where confirmado_em is null and descartado_em is null group by canal;`
5. **Reverter a confirmacao** (`20261113100000` rollback). Ele recusa sozinho se houver pendente.
6. **Verificar pendentes ANTES de reverter a protecao:** repetir o passo 4. Se houver pendente, **parar**: nao executar o passo 7. A protecao de e-mail continua vigente.
7. **Reverter a protecao** (`20261113100100` rollback). Recusa sozinha se houver pendente ou se a confirmacao ainda existir.
8. **Verificacao pos-COMMIT:** repetir o passo 4 (esperado zero) e conferir os md5 das funcoes (`c9cc7498…` para a exportacao; `00d3370a…` para a funcao de e-mails).
9. **Restaurar o EXECUTE** revogado no passo 2 somente depois do passo 8.

## Se algo falhar
- Se o passo 6 achar pendente: nao reverter a protecao. Tratar o lote pela operacao (tabular ou descartar), registrar a ocorrencia e repetir a janela.
- Se o passo 8 achar pendente apos a reversao da protecao: tratar como incidente; o lote fica pendente e a exportacao de e-mail ja nao o protege. Registrar e decidir a recomposicao com a gestao.

## Testes e evidencias
- Local (PGlite, conexao unica): `supabase/tests/acoes_massivas_ordem_aplicacao.test.js`, `acoes_massivas_confirmar_envio.test.js` e `acoes_massivas_email_so_apos_tabulacao.test.js` (43 casos no total, nos tres arquivos). Cobrem logica, ordem e preservacao; **nao cobrem concorrencia**.
- Concorrencia (duas conexoes): `scripts/ci/teste-reversao-concorrencia.sh`. **NAO executado** (sem PostgreSQL no ambiente local). Pendente de banco de teste; ver o cabecalho do script.
