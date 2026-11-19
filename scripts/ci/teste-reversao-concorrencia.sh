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
# Duas classes de falha, rotuladas: PREPARACAO (bancada incompleta; nada foi testado) e SEGURANCA (comportamento errado).
falha() { echo "FALHA DE SEGURANCA/COMPORTAMENTO: $1 (logs em $LOG)" >&2; exit 1; }
falha_prep() { echo "FALHA DE PREPARACAO: $1 (logs em $LOG). Nada foi testado; nao e prova de ausencia de acesso." >&2; exit 1; }
for R in anon authenticated service_role; do
  [ "$(P -tA -c "select count(*) from pg_roles where rolname='$R'")" = "1" ] || falha_prep "papel '$R' ausente na bancada"
done
md5_exp() { P -tA -c "select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='acoes_massivas_exportar'"; }
acl() { P -tA -c "select proacl::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=\$\$$1\$\$"; }
espera_trava() { for _ in $(seq 1 100); do
  n=$(P -tA -c "select count(*) from pg_locks l join pg_class c on c.oid=l.relation where c.relname='acoes_massivas_lotes' and l.mode='RowExclusiveLock' and l.granted")
  [ "$n" -ge 1 ] && return 0; sleep 0.2; done; falha "a sessao seguradora nao obteve a trava"; }

# B1: permissoes EFETIVAS de TODAS as funcoes tocadas pelas migrations pendentes, medidas em cada etapa.
# Efetivo = has_function_privilege por papel de pg_roles + PUBLIC pela ACL (aclexplode; proacl NULL = padrao).
# Funcao ausente aparece como ABSENTE. Nunca se usa o estado posterior a um rollback como referencia.
F_EXP="public.acoes_massivas_exportar(text[],text,text,text,text,uuid)"
F_EML="public.acoes_massivas_exportar_emails_do_lote(uuid,text)"
F_LOT="public.acoes_massivas_concluir_lote(uuid,text)"
F_ENV="public.acoes_massivas_concluir_envio(uuid,text,text[])"
F_DST="public.acoes_massivas_lote_destinatarios(uuid)"
F1="$F_EXP"; F2="$F_EML"
PROT_F="$D/20261113100100_acoes_massivas_email_so_apos_tabulacao.sql.pendente"
CONF_F="$D/20261113100000_acoes_massivas_confirmar_envio.sql.pendente"
NOVA_F="$D/20261113100200_acoes_massivas_concluir_lote_bloqueia_pendente.sql.pendente"
NOVA_RB="$D/20261113100200_acoes_massivas_concluir_lote_bloqueia_pendente.rollback.sql"
# efetivas FUNC... : uma linha por funcao x papel (todos de pg_roles) + uma linha PUBLIC por funcao.
efetivas() {
  local vals="" f
  for f in "$@"; do vals="$vals ('$f'),"; done
  vals="${vals%,}"
  P -tA -c "select string_agg(x, ';' order by x) from (
      select f||':'||r.rolname||'='||case when to_regprocedure(f) is null then 'ABSENTE'
             else has_function_privilege(r.rolname, f, 'EXECUTE')::text end as x
        from (values $vals) as fx(f), pg_roles r
      union all
      select f||':PUBLIC='||case when to_regprocedure(f) is null then 'ABSENTE' else
             (select (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a
                       where a.grantee=0 and a.privilege_type='EXECUTE'))::text
                from pg_proc p where p.oid = to_regprocedure(f)) end
        from (values $vals) as fx(f)
  ) t"
}
TODAS=("$F_EXP" "$F_EML" "$F_LOT" "$F_ENV" "$F_DST")
catalogo() { P -tA -c "select string_agg(coalesce(proacl::text,'NULL'), ' | ' order by proname) from pg_proc where oid in ('$F1'::regprocedure,'$F2'::regprocedure)"; }

# Passo 0: o banco nasce ANTES da 100100 (corpo publicado de e-mail, 00d3370a). Referencia = esse estado.
E_ANTES_100100=$(efetivas "$F_EML")
[ -n "$E_ANTES_100100" ] || falha_prep "B1: snapshot de permissoes vazio antes da 100100 (consulta falhou)"

# Passo 1: aplica a 100100 (protecao de e-mail). A 100100 muda o corpo de exportar_emails;
# a permissao efetiva precisa permanecer igual, e isso e medido logo abaixo.
P -f "$PROT_F" >"$LOG/b1_100100" 2>&1 || falha "B1: aplicacao da 100100 falhou (log: $LOG/b1_100100)"
[ "$(efetivas "$F_EML")" = "$E_ANTES_100100" ] || falha "B1: aplicacao da 100100 ALTEROU permissoes efetivas de exportar_emails"
E_PRE=$(efetivas "${TODAS[@]}")   # referencia ANTES da 100000 (FC/FD ABSENTE)

# Passo 2: aplica a 100000. Existentes: iguais. Novas (concluir_envio, lote_destinatarios): so anon=f, PUBLIC=f.
P -f "$CONF_F" >"$LOG/b1_100000" 2>&1 || falha "B1: aplicacao da 100000 falhou (log: $LOG/b1_100000)"
E_100000=$(efetivas "${TODAS[@]}")
# Existentes (exportar, emails, concluir_lote): efetivo identico ao de antes da 100000.
[ "$(efetivas "$F_EXP" "$F_EML" "$F_LOT")" = "$(printf '%s' "$E_PRE" | tr ';' '\n' | grep -E '^(public\.acoes_massivas_(exportar|exportar_emails_do_lote|concluir_lote)\()' | tr '\n' ';' | sed 's/;$//')" ] || falha "B1: 100000 alterou permissoes efetivas de funcao existente"
for f in "$F_ENV" "$F_DST"; do
  for r in anon PUBLIC; do
    # PUBLIC pela ACL (aclexplode); anon existe (preflight). grep -F: assinatura tem regex.
    v=$(printf '%s' "$E_100000" | tr ';' '\n' | grep -F "$f:$r=" | cut -d= -f2 || true)
    [ -n "$v" ] || falha_prep "B1: resultado vazio para $f/$r apos 100000 (preparacao incompleta)"
    [ "$v" = "false" ] || falha "B1: 100000 expos $f a $r (valor='$v', esperado: false)"
  done
  for r in authenticated service_role; do
    [ "$(P -tA -c "select has_function_privilege('$r','$f','EXECUTE')::text")" = "true" ] || falha "B1: 100000 nao concede $f a $r"
  done
done
echo "B1 ok: 100000 aplicada; novas funcoes concedidas so a authenticated e service_role"

# Passo 3: aplica a 100200 (recusa de CONFIRMAR de lote pendente). So corpo: efetivo nao muda.
E_ANTES_200=$(efetivas "${TODAS[@]}")
P -f "$NOVA_F" >"$LOG/b1_100200" 2>&1 || falha "B1: aplicacao da 100200 falhou (log: $LOG/b1_100200)"
[ "$(efetivas "${TODAS[@]}")" = "$E_ANTES_200" ] || falha "B1: aplicacao da 100200 ALTEROU permissoes efetivas"
echo "B1 ok: 100200 aplicada sem alterar permissoes efetivas"

# Passo 4: rollback da 100200 -> efetivo volta ao de antes dela.
P -f "$NOVA_RB" >"$LOG/b1_rb100200" 2>&1 || falha "B1: rollback da 100200 falhou (log: $LOG/b1_rb100200)"
[ "$(efetivas "${TODAS[@]}")" = "$E_ANTES_200" ] || falha "B1: rollback da 100200 NAO restaurou o efetivo anterior"
echo "B1 ok: rollback da 100200 restaurou o efetivo anterior"

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
[ "$(efetivas "${TODAS[@]}")" = "$E_PRE" ] || falha "C2: rollback NAO restaurou as permissoes efetivas anteriores a 100000 (incluindo ausencia das funcoes novas)"
echo "B1 ok: rollback da 100000 restaurou o efetivo anterior (incluindo a ausencia de concluir_envio e lote_destinatarios)"
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

# C4: permissoes EFETIVAS. Mecanismos suportados apenas: REVOKE/GRANT. Nao escreve em pg_proc diretamente (so REVOKE/GRANT).
# Catalogo (proacl) e registrado so como informacao: GRANT pode trocar NULL por ACL explicita sem mudar
# quem executa. A comparacao que vale e has_function_privilege por papel, antes e depois.
E_ANTES=$(efetivas "$F1" "$F2"); C_ANTES=$(catalogo)
[ -n "$E_ANTES" ] || falha_prep "C4: snapshot de permissoes efetivas vazio (consulta falhou)"
# Limpeza: tenta reconceder EXECUTE a authenticated. Falha de recuperacao e sinalizada a parte (nao engole).
restaurar() {
  if ! P -c "grant execute on function $F1 to authenticated; grant execute on function $F2 to authenticated;" >"$LOG/restaurar" 2>&1; then
    echo "FALHA DE RECUPERACAO (limpeza de grants): reconceder EXECUTE a authenticated falhou; verificar manualmente. Log: $LOG/restaurar" >&2
    return 1
  fi
}
trap 'restaurar' EXIT
P -c "revoke execute on function $F1 from authenticated; revoke execute on function $F2 from authenticated;"
[ "$(P -tA -c "select has_function_privilege('authenticated','$F1','EXECUTE')")" = "f" ] || falha "C4: revoke nao aplicado"
[ "$(P -tA -c "select has_function_privilege('service_role','$F1','EXECUTE')")" = "t" ] || falha "C4: service_role foi afetado pelo revoke de authenticated (inesperado)"
restaurar
E_DEPOIS=$(efetivas "$F1" "$F2")
[ "$E_DEPOIS" = "$E_ANTES" ] || falha "C4: permissoes efetivas divergentes apos restauracao: antes=[$E_ANTES] depois=[$E_DEPOIS]"
trap - EXIT
C_DEPOIS=$(catalogo)
if [ "$C_DEPOIS" != "$C_ANTES" ]; then echo "C4 info: representacao do catalogo difere (esperado pelo GRANT): antes=[$C_ANTES] depois=[$C_DEPOIS]"; fi
echo "C4 ok: permissoes efetivas identicas por papel apos REVOKE/GRANT (sem ampliar nem perder acesso)"

# C5: rollback da 100100 CONCLUI (sem concluir_envio e sem pendentes) e volta ao efetivo de antes da 100100.
P -f "$RB_PROT" >"$LOG/c5" 2>&1 || falha "C5: rollback da 100100 deveria concluir (log: $LOG/c5)"
[ "$(efetivas "$F_EML")" = "$E_ANTES_100100" ] || falha "C5: rollback da 100100 NAO restaurou o efetivo de exportar_emails"
echo "C5 ok: rollback da 100100 concluiu e restaurou o efetivo anterior"

# Residuos: nenhum lote pendente, nenhuma transacao aberta deixada pelos cenarios.
[ "$(P -tA -c "select count(*) from public.acoes_massivas_lotes where confirmado_em is null and descartado_em is null")" = "0" ] || falha "residuo: lote pendente restou"
[ "$(P -tA -c "select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and state='idle in transaction'")" = "0" ] || falha "residuo: transacao aberta restou"
echo "RESIDUOS ok: nenhum lote pendente e nenhuma transacao aberta"
echo "B1 e C1-C5 OK no banco descartavel $DB."
