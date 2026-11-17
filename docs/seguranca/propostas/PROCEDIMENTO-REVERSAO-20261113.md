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
2. **Pausar novas chamadas**, em todos os caminhos de execucao, nao so no front. Antes, **registrar as permissoes efetivas** (`has_function_privilege` por papel: anon, authenticated, service_role, public) e, como informacao, o `proacl` atual. A restauracao e por GRANT/REVOKE; o `proacl` pode mudar de representacao (NULL vs ACL explicita) sem mudar quem executa, e isso e documentado, nao escondido:
   `select proname, proacl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname in ('acoes_massivas_exportar','acoes_massivas_exportar_emails_do_lote');`
   - revogar EXECUTE de `authenticated` nessas funcoes durante a janela;
   - inventariar e pausar tambem `service_role`, cron e edge functions que chamem essas funcoes (inventario a fazer; NAO conferido);
   - publicar o front sem o botao, se houver risco de chamada direta.
3. **Confirmar o termino das existentes** (consulta somente leitura, repetida ate zero linhas por um intervalo de observacao definido pela gestao):
   `select pid, state, left(query,120) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state in ('active','idle in transaction') and query ilike '%acoes_massivas_exportar%';`
   Sessao `idle in transaction` com essa query **conta como pendencia**: encerrar somente com autorizacao, nunca por conta propria. Sessao `idle` (pool) nao conta.
4. **Contagem momentanea de pendentes por canal, com data e hora** (evidencia; nao substitui a checagem do rollback):
   `select now(), canal, count(*) from public.acoes_massivas_lotes where confirmado_em is null and descartado_em is null group by canal;`
5. **Reverter a confirmacao** (`20261113100000` rollback). Ele recusa sozinho se houver pendente.
6. **Verificar pendentes ANTES de reverter a protecao:** repetir o passo 4. Se houver pendente, **parar**: nao executar o passo 7. A protecao de e-mail continua vigente.
7. **Reverter a protecao** (`20261113100100` rollback). Recusa sozinha se houver pendente ou se a confirmacao ainda existir.
8. **Verificacao pos-COMMIT:** repetir o passo 4 (esperado zero) e conferir os md5 das funcoes (`c9cc7498…` para a exportacao; `00d3370a…` para a funcao de e-mails).
9. **Restaurar as permissoes** com GRANT EXECUTE para os mesmos papeis do passo 2, somente depois do passo 8 (nada a mais). Conferir as permissoes **efetivas** por papel contra o snapshot; divergencia de `proacl` so e aceita se as efetivas forem iguais e a diferenca estiver registrada.

## Se algo falhar
- Se o passo 6 achar pendente: nao reverter a protecao. Tratar o lote pela operacao (tabular ou descartar) pela funcao `acoes_massivas_concluir_lote`, que existe em producao; **esse caminho para lote PENDENTE_ENVIO ainda NAO foi confirmado** e deve ser conferido antes da janela. Registrar a ocorrencia e repetir a janela.
- Se o passo 8 achar pendente apos a reversao da protecao: tratar como incidente; o lote fica pendente e a exportacao de e-mail ja nao o protege. Registrar e decidir a recomposicao com a gestao.

## Inventario por leitura (17/11/2026, sem alterar producao)
- **Grants efetivos** das funcoes: `service_role`, `authenticated` e `postgres` tem EXECUTE em `acoes_massivas_exportar`, `acoes_massivas_exportar_emails_do_lote` e `acoes_massivas_concluir_lote`. **Revogar so de `authenticated` nao pausa `service_role`.** `anon` nao tem EXECUTE nessas tres.
- **Cron (pg_cron, 60+ jobs ativos e inativos):** nenhum comando menciona `acoes_massivas`. Nenhum job de cron dispara exportacao.
- **Edge Functions implantadas (38):** nenhuma tem fonte no repositorio chamando `acoes_massivas`. **Ha funcoes implantadas sem fonte no repositorio**, entre elas `exportar-gestao`, `prime-buscar-nome`, `prime-titular`, `prime-extrato`, `prime-acordo`. Nao e possivel afirmar que nenhuma delas chama a exportacao: a fonte nao esta disponivel para leitura. **Pendencia para a gestao.**
- **Chamadores no front:** somente `src/pages/AcoesMassivas.jsx`.

## Tratamento de lote PENDENTE_ENVIO (decisao de negocio, nao automatica)
- `acoes_massivas_concluir_lote(lote, 'CONFIRMAR')` **aceita** lote pendente (testado em banco descartavel): registra todos os destinatarios do lote como acionados (equivale a TOTAL). **Isso presume que o disparo ocorreu para todos.**
- `DESCARTAR` marca o lote como descartado, sem registro.
- Nao existe tratamento parcial por `acoes_massivas_concluir_lote`; a confirmacao parcial e da funcao `acoes_massivas_concluir_envio`, que e removida pelo rollback da confirmacao.
- **Escolha a fazer pela gestao, por lote:** (a) confirmar como enviado para todos, se o disparo ocorreu; (b) descartar, se nao ocorreu; (c) manter pendente e adiar a janela. Nao ha regra automatica no procedimento.

## Testes e evidencias
- Local (PGlite, conexao unica): `supabase/tests/acoes_massivas_ordem_aplicacao.test.js`, `acoes_massivas_confirmar_envio.test.js` e `acoes_massivas_email_so_apos_tabulacao.test.js` (43 casos no total, nos tres arquivos). Cobrem logica, ordem e preservacao; **nao cobrem concorrencia**.
- Concorrencia (duas conexoes): `scripts/ci/teste-reversao-concorrencia.sh`. **NAO executado** (sem PostgreSQL no ambiente local). Pendente de banco de teste; ver o cabecalho do script.
