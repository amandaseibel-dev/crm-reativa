#!/usr/bin/env bash
# Teste de CONCORRENCIA e de GRANTS das reversoes (20261113100000 / 20261113100100) em
# PostgreSQL DESCARTAVEL criado pelo CI (job "reversao concorrencia"). Nunca producao.
#
# Protecao (fail-closed; cada uma sai com codigo 2 ANTES de qualquer escrita):
#   1. CONFIRMAR_BANCO_DESCARTAVEL=sim-descartavel (confirmacao explicita);
#   2. host do PG_URL em {localhost, 127.0.0.1, postgres} (servico do CI);
#   3. nome do banco exatamente "reversao_ci_teste";
#   4. token DESCARTAVEL_TOKEN (32 hex) presente em public.ambiente_descartavel, gravado
#      pelo CI ao criar o banco. Banco de producao nao tem essa tabela com este token.
# Codigos: 0 = todos os cenarios; 2 = recusa; 1 = falha.
set -euo pipefail
recusa() { echo "RECUSADO: $1" >&2; exit 2; }
[ "${CONFIRMAR_BANCO_DESCARTAVEL:-}" = "sim-descartavel" ] || recusa "defina CONFIRMAR_BANCO_DESCARTAVEL=sim-descartavel"
: "${PG_URL:?defina PG_URL}"
: "${DESCARTAVEL_TOKEN:?defina DESCARTAVEL_TOKEN}"
[[ "$DESCARTAVEL_TOKEN" =~ ^[a-f0-9]{32}$ ]] || recusa "token com formato invalido"
HOST=$(printf '%s' "$PG_URL" | sed -E 's#^[a-z]+://([^@]*@)?([^:/?]+).*#\2#')
case "$HOST" in localhost|127.0.0.1|postgres) ;; *) recusa "host '$HOST' nao autorizado" ;; esac
P() { psql "$PG_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }
DB=$(P -tA -c "select current_database()") || recusa "nao consegui autenticar/conectar ao banco"
[ "$DB" = "reversao_ci_teste" ] || recusa "banco '$DB' nao e 'reversao_ci_teste'"
TOK=$(P -tA -c "select token from public.ambiente_descartavel where token = '$DESCARTAVEL_TOKEN'" 2>/dev/null || true)
[ "$TOK" = "$DESCARTAVEL_TOKEN" ] || recusa "token de ambiente descartavel nao confere"

D=supabase/aguardando_aprovacao
RB_CONF="$D/20261113100000_acoes_massivas_confirmar_envio.rollback.sql"
RB_PROT="$D/20261113100100_acoes_massivas_email_so_apos_tabulacao.rollback.sql"
LOG=$(mktemp -d)
falha() { echo "FALHA: $1 (logs em $LOG)" >&2; exit 1; }
md5_exp() { P -tA -c "select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='acoes_massivas_exportar'"; }
acl() { P -tA -c "select proacl::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=\$\$$1\$\$"; }
espera_trava() { for _ in $(seq 1 100); do
  n=$(P -tA -c "select count(*) from pg_locks l join pg_class c on c.oid=l.relation where c.relname='acoes_massivas_lotes' and l.mode='RowExclusiveLock' and l.granted")
  [ "$n" -ge 1 ] && return 0; sleep 0.2; done; falha "a sessao seguradora nao obteve a trava"; }

# C1: trava ocupada -> reversao RECUSADA por lock timeout (55P03); nada muda.
ANTES=$(md5_exp)
P -c "BEGIN; LOCK TABLE public.acoes_massivas_lotes IN ROW EXCLUSIVE MODE; SELECT pg_sleep(20); COMMIT;" >"$LOG/h1" 2>&1 & H1=$!
espera_trava
if P -f "$RB_CONF" >"$LOG/c1" 2>&1; then falha "C1: reversao concluiu com a trava ocupada"; fi
grep -q "lock timeout" "$LOG/c1" || falha "C1: a recusa nao foi lock timeout"
[ "$(md5_exp)" = "$ANTES" ] || falha "C1: funcao alterada apesar da recusa"
wait $H1 || falha "C1: sessao seguradora falhou"
echo "C1 ok: trava ocupada -> lock timeout; nada mudou"

# C2: trava livre -> reversao da confirmacao CONCLUI.
P -f "$RB_CONF" >"$LOG/c2" 2>&1 || falha "C2: deveria concluir com a trava livre"
[ "$(md5_exp)" != "$ANTES" ] || falha "C2: concluiu mas a funcao nao mudou"
echo "C2 ok: reversao da confirmacao concluiu"

# C3: exportacao (INSERT = ROW EXCLUSIVE) aberta e nao commitada -> reversao da protecao RECUSADA.
P -c "BEGIN; INSERT INTO public.acoes_massivas_lotes (canal,arquivo,aluno_ids,total,exportado_por_email,tipo_cobranca,recencia_dias) SELECT 'WHATSAPP','c3.xlsx','{}'::text[],0,'teste@x',NULL,10; SELECT pg_sleep(20); ROLLBACK;" >"$LOG/h3" 2>&1 & H3=$!
espera_trava
M_EMAIL_ANTES=$(P -tA -c "select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='acoes_massivas_exportar_emails_do_lote'")
if P -f "$RB_PROT" >"$LOG/c3" 2>&1; then falha "C3: protecao revertida enquanto a exportacao segurava a trava"; fi
grep -q "lock timeout" "$LOG/c3" || falha "C3: a recusa nao foi lock timeout"
[ "$(P -tA -c "select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='acoes_massivas_exportar_emails_do_lote'")" = "$M_EMAIL_ANTES" ] || falha "C3: funcao de e-mails alterada"
wait $H3 || falha "C3: sessao da exportacao falhou"
echo "C3 ok: reversao da protecao recusada com a exportacao em andamento"

# C4: permissoes EFETIVAS. Mecanismos suportados apenas: REVOKE/GRANT. Nao escreve em pg_proc.
# Catalogo (proacl) e registrado so como informacao: GRANT pode trocar NULL por ACL explicita sem mudar
# quem executa. A comparacao que vale e has_function_privilege por papel, antes e depois.
F1="public.acoes_massivas_exportar(text[],text,text,text,text,uuid)"
F2="public.acoes_massivas_exportar_emails_do_lote(uuid,text)"
# Papeis: TODOS os roles do banco (pg_roles), nao uma lista fixa. has_function_privilege herda memberships.
# PUBLIC nao e role: has_function_privilege('public',...) nao e valido. Efetivo de PUBLIC = EXECUTE na ACL
# com grantee 0 (aclexplode) ou, com proacl NULL, o padrao do Postgres (EXECUTE para PUBLIC).
efetivas() {
  P -tA -c "select string_agg(x, ';' order by x) from (
      select f||':'||r.rolname||'='||has_function_privilege(r.rolname, f, 'EXECUTE')::text as x
        from (values ('$F1'),('$F2')) as fx(f), pg_roles r
      union all
      select p.oid::regprocedure::text||':PUBLIC='||(p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee=0 and a.privilege_type='EXECUTE'))::text
        from pg_proc p where p.oid in ('$F1'::regprocedure,'$F2'::regprocedure)
  ) t"
}
catalogo() { P -tA -c "select string_agg(coalesce(proacl::text,'NULL'), ' | ' order by proname) from pg_proc where oid in ('$F1'::regprocedure,'$F2'::regprocedure)"; }
E_ANTES=$(efetivas); C_ANTES=$(catalogo)
[ -n "$E_ANTES" ] || falha "C4: snapshot de permissoes efetivas vazio (consulta falhou)"
restaurar() { P -c "grant execute on function $F1 to authenticated; grant execute on function $F2 to authenticated;" >/dev/null 2>&1 || true; }
trap 'restaurar' EXIT
P -c "revoke execute on function $F1 from authenticated; revoke execute on function $F2 from authenticated;"
[ "$(P -tA -c "select has_function_privilege('authenticated','$F1','EXECUTE')")" = "f" ] || falha "C4: revoke nao aplicado"
[ "$(P -tA -c "select has_function_privilege('service_role','$F1','EXECUTE')")" = "t" ] || falha "C4: service_role foi afetado pelo revoke de authenticated (inesperado)"
restaurar
E_DEPOIS=$(efetivas)
[ "$E_DEPOIS" = "$E_ANTES" ] || falha "C4: permissoes efetivas divergentes apos restauracao: antes=[$E_ANTES] depois=[$E_DEPOIS]"
trap - EXIT
C_DEPOIS=$(catalogo)
if [ "$C_DEPOIS" != "$C_ANTES" ]; then echo "C4 info: representacao do catalogo difere (esperado pelo GRANT): antes=[$C_ANTES] depois=[$C_DEPOIS]"; fi
echo "C4 ok: permissoes efetivas identicas por papel apos REVOKE/GRANT (sem ampliar nem perder acesso)"

# Residuos: nenhum lote pendente, nenhuma transacao aberta deixada pelos cenarios.
[ "$(P -tA -c "select count(*) from public.acoes_massivas_lotes where confirmado_em is null and descartado_em is null")" = "0" ] || falha "residuo: lote pendente restou"
[ "$(P -tA -c "select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and state='idle in transaction'")" = "0" ] || falha "residuo: transacao aberta restou"
echo "RESIDUOS ok: nenhum lote pendente e nenhuma transacao aberta"
echo "C1-C4 OK no banco descartavel $DB."
