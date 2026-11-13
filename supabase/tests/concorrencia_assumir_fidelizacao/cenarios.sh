#!/usr/bin/env bash
# CONCORRENCIA REAL em Postgres 16: duas sessoes psql de verdade.
# Sessao A segura o lock (BEGIN ... pg_sleep ... COMMIT); sessao B chama a RPC
# enquanto A esta aberta. B tem de ESPERAR, e so depois ver o que A gravou.
set -euo pipefail
DIR=supabase/tests/concorrencia_assumir_fidelizacao
OUT=$(mktemp -d)
LUANA=cobranca05@aelbra.com.br
MAURICIO=cobranca06@aelbra.com.br
U1=00000000-0000-0000-0000-000000000001
U2=00000000-0000-0000-0000-000000000002
U3=00000000-0000-0000-0000-000000000003
falhas=0
ok()   { echo "  ok    $1"; }
falha(){ echo "  FALHA $1"; falhas=$((falhas+1)); }
jwt()  { echo "select set_config('request.jwt.claims', '{\"email\":\"$1\"}', false);"; }
q()    { psql -At -v ON_ERROR_STOP=1 -c "$1"; }

# Cada cenario roda num banco NOVO: as fixtures criam objetos e nao podem repetir.
ambiente() {
  export PGDATABASE="teste_$1"
  dropdb --if-exists "$PGDATABASE"; createdb "$PGDATABASE"
  psql -v ON_ERROR_STOP=1 -q -f "$DIR/01_ambiente.sql" >/dev/null
  psql -v ON_ERROR_STOP=1 -q -f "$DIR/02_casos.sql" >/dev/null
}

echo "== C1: dois operadores disputam o mesmo caso (U1)"
ambiente c1
# A: LUANA assume e segura a transacao 4s.
( { echo "begin;"; jwt $LUANA; echo "select sucesso, mensagem from public.assumir_caso_fidelizacao_vencida('$U1','disputa A');"; echo "select pg_sleep(4);"; echo "commit;"; } \
    | psql -At -v ON_ERROR_STOP=1 > "$OUT/a.txt" 2>&1 ) &
sleep 1
# B: MAURICIO tenta logo em seguida. Tem de bloquear ate o commit de A.
inicio=$(date +%s)
{ jwt $MAURICIO; echo "select sucesso, mensagem from public.assumir_caso_fidelizacao_vencida('$U1','disputa B');"; } \
  | psql -At -v ON_ERROR_STOP=1 > "$OUT/b.txt" 2>&1 || true
espera=$(( $(date +%s) - inicio ))
wait
[ "$espera" -ge 2 ] && ok "B esperou o lock de A (${espera}s)" || falha "B nao esperou o lock (${espera}s)"
grep -q '^t|' "$OUT/a.txt" && ok "A assumiu" || falha "A nao assumiu: $(cat "$OUT/a.txt")"
grep -q '^f|Este caso nao esta disponivel' "$OUT/b.txt" && ok "B recusada depois do commit" || falha "B nao recusada: $(cat "$OUT/b.txt")"
[ "$(q "select operador_email from public.casos where aluno_id='$U1'")" = "$LUANA" ] && ok "dono final e LUANA" || falha "dono final errado"
[ "$(q "select count(*) from public.historico_operadores_alunos where acao='ASSUMIR_FIDELIZACAO_VENCIDA' and cpf_referencia=(select cpf from public.casos where aluno_id='$U1')")" = "1" ] && ok "uma unica linha de auditoria" || falha "auditoria duplicada ou ausente"

echo "== C2: acionamento VALIDO gravado so no ALUNO, concorrente com a tomada (U2)"
ambiente c2
( { echo "begin;"; echo "update public.alunos set data_ultimo_acionamento = current_date where id='$U2';"; echo "select pg_sleep(4);"; echo "commit;"; } \
    | psql -At -v ON_ERROR_STOP=1 > "$OUT/acion.txt" 2>&1 ) &
sleep 1
{ jwt $LUANA; echo "select sucesso, mensagem from public.assumir_caso_fidelizacao_vencida('$U2','tomada concorrente');"; } \
  | psql -At -v ON_ERROR_STOP=1 > "$OUT/t2.txt" 2>&1 || true
wait
grep -q '^f|Este caso nao esta disponivel' "$OUT/t2.txt" && ok "tomada recusada pelo acionamento do aluno" || falha "tomada passou: $(cat "$OUT/t2.txt")"
[ "$(q "select operador_email from public.casos where aluno_id='$U2'")" = "$MAURICIO" ] && ok "dono continua MAURICIO" || falha "caso mudou de dono"

echo "== C3: acionamento VALIDO gravado so no CASO, concorrente com a tomada (U3)"
ambiente c3
( { echo "begin;"; echo "update public.casos set data_ultimo_acionamento = current_date where aluno_id='$U3';"; echo "select pg_sleep(4);"; echo "commit;"; } \
    | psql -At -v ON_ERROR_STOP=1 > "$OUT/acion3.txt" 2>&1 ) &
sleep 1
{ jwt $LUANA; echo "select sucesso, mensagem from public.assumir_caso_fidelizacao_vencida('$U3','tomada concorrente 3');"; } \
  | psql -At -v ON_ERROR_STOP=1 > "$OUT/t3.txt" 2>&1 || true
wait
grep -q '^f|Este caso nao esta disponivel' "$OUT/t3.txt" && ok "tomada recusada pelo acionamento do caso" || falha "tomada passou: $(cat "$OUT/t3.txt")"
[ "$(q "select operador_email from public.casos where aluno_id='$U3'")" = "$MAURICIO" ] && ok "dono continua MAURICIO" || falha "caso mudou de dono"

echo "== C4: dois alunos diferentes disputam a ultima vaga do teto (limite 3; LUANA tem 2)"
ambiente c4
psql -v ON_ERROR_STOP=1 -q -c "update public.calibragem_parametros set valor='3'::jsonb where chave='limite_carteira';" >/dev/null
( { echo "begin;"; jwt $LUANA; echo "select sucesso, mensagem from public.assumir_caso_fidelizacao_vencida('00000000-0000-0000-0000-000000000006','teto A');"; echo "select pg_sleep(4);"; echo "commit;"; } \
    | psql -At -v ON_ERROR_STOP=1 > "$OUT/c4a.txt" 2>&1 ) &
sleep 1
{ jwt $LUANA; echo "select sucesso, mensagem from public.assumir_caso_fidelizacao_vencida('00000000-0000-0000-0000-000000000007','teto B');"; } \
  | psql -At -v ON_ERROR_STOP=1 > "$OUT/c4b.txt" 2>&1 || true
wait
sa=$(grep -c '^t|' "$OUT/c4a.txt" || true); sb=$(grep -c '^t|' "$OUT/c4b.txt" || true)
[ $((sa+sb)) -eq 1 ] && ok "exatamente uma tomada passou no teto" || falha "teto violado: A=$sa B=$sb"
n=$(q "select count(*) from public.casos where operador_email='$LUANA' and aluno_id in ('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000007') and not public.caso_encerrado_operacional(cpf_limpo,status_atual,status_acionamento,status_financeiro,status_jornada)")
[ "$n" -le 3 ] && ok "carteira de LUANA ficou em $n (limite 3)" || falha "carteira de LUANA em $n, acima do limite 3"

echo
[ "$falhas" -eq 0 ] && echo "CONCORRENCIA: todos os cenarios passaram" || { echo "CONCORRENCIA: $falhas falha(s)"; exit 1; }
