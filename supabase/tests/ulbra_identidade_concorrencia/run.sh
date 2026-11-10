#!/usr/bin/env bash
# Corrida REAL entre duas sessões (PostgreSQL 17): coleta (INSERT de conversa)
# e alteração/revogação de vínculo, nos dois sentidos. Sem chamada à ULBRA.
set -euo pipefail
export PGHOST="${PGHOST:-localhost}" PGPORT="${PGPORT:-5432}" PGUSER="${PGUSER:-postgres}" PGPASSWORD="${PGPASSWORD:-postgres}" PGDATABASE="${PGDATABASE:-teste}"
DIR=supabase/tests/ulbra_identidade_concorrencia
REC=supabase/tests/ulbra_recebimento
PILOTO=supabase/aguardando_aprovacao/20261108140000_ulbra_recebimento_e_fila.sql.pendente
MIG=supabase/aguardando_aprovacao/20261110130000_ulbra_identidade_propagada.sql.pendente
ALUNO=11111111-1111-1111-1111-111111111111
conv() { psql -v ON_ERROR_STOP=1 -q -c "insert into public.ulbra_conversas (ulbra_conversa_id, ulbra_cliente_id, cliente_nome, canal, situacao, equipe, ultima_mensagem_quem, ultima_mensagem_em, ultima_mensagem_cliente_em) values ('$1','$2','A','whatsapp','active','Reativa','cliente', now(), now())"; }
status() { psql -tA -v ON_ERROR_STOP=1 -c "select aluno_status from public.ulbra_conversas where ulbra_conversa_id='$1'"; }
reset() {
  psql -v ON_ERROR_STOP=1 -q -c "drop schema public cascade; create schema public; grant usage on schema public to anon, authenticated, service_role;"
  psql -v ON_ERROR_STOP=1 -q -f "$REC/01_ambiente.sql"
  psql -v ON_ERROR_STOP=1 -q -f "$PILOTO"
  psql -v ON_ERROR_STOP=1 -q -f "$DIR/00_stub_vinculos.sql"
  psql -v ON_ERROR_STOP=1 -q -f "$MIG"
}
falha=0
afirma() { if [ "$2" = "$3" ]; then echo "OK  $1: $2"; else echo "FALHOU $1: esperado '$3', obteve '$2'"; falha=1; fi; }

# ---- 1. COLETA primeiro, vínculo depois (A insere e segura; B vincula) ----
reset
( psql -v ON_ERROR_STOP=1 -q -c "begin; insert into public.ulbra_conversas (ulbra_conversa_id, ulbra_cliente_id, cliente_nome, canal, situacao, equipe, ultima_mensagem_quem, ultima_mensagem_em, ultima_mensagem_cliente_em) values ('k1','cli-k1','A','whatsapp','active','Reativa','cliente', now(), now()); select pg_sleep(3); commit;" ) &
sleep 1
psql -v ON_ERROR_STOP=1 -q -c "insert into public.ulbra_vinculos (aluno_id, ulbra_cliente_id, confianca, origem) values ('$ALUNO', 'cli-k1', 'alta_cpf', 'cpf')"
wait
afirma "coleta primeiro, vínculo depois" "$(status k1)" "vinculado"

# ---- 2. VÍNCULO primeiro (B segura; A insere depois e espera) ----
reset
( psql -v ON_ERROR_STOP=1 -q -c "begin; insert into public.ulbra_vinculos (aluno_id, ulbra_cliente_id, confianca, origem) values ('$ALUNO', 'cli-k2', 'alta_cpf', 'cpf'); select pg_sleep(3); commit;" ) &
sleep 1
conv k2 cli-k2
wait
afirma "vínculo primeiro, coleta depois" "$(status k2)" "vinculado"

# ---- 3. REVOGAÇÃO primeiro (B revoga e segura; A insere depois e espera) ----
reset
psql -v ON_ERROR_STOP=1 -q -c "insert into public.ulbra_vinculos (aluno_id, ulbra_cliente_id, confianca, origem) values ('$ALUNO', 'cli-k3', 'alta_cpf', 'cpf')"
( psql -v ON_ERROR_STOP=1 -q -c "begin; update public.ulbra_vinculos set desvinculado_em = now() where ulbra_cliente_id = 'cli-k3' and desvinculado_em is null; select pg_sleep(3); commit;" ) &
sleep 1
conv k3 cli-k3
wait
afirma "revogação primeiro, coleta depois" "$(status k3)" "nao_confirmado"

# ---- 4. COLETA primeiro com vínculo ativo; B revoga e espera o commit da coleta ----
reset
psql -v ON_ERROR_STOP=1 -q -c "insert into public.ulbra_vinculos (aluno_id, ulbra_cliente_id, confianca, origem) values ('$ALUNO', 'cli-k4', 'alta_cpf', 'cpf')"
( psql -v ON_ERROR_STOP=1 -q -c "begin; insert into public.ulbra_conversas (ulbra_conversa_id, ulbra_cliente_id, cliente_nome, canal, situacao, equipe, ultima_mensagem_quem, ultima_mensagem_em, ultima_mensagem_cliente_em) values ('k4','cli-k4','A','whatsapp','active','Reativa','cliente', now(), now()); select pg_sleep(3); commit;" ) &
sleep 1
psql -v ON_ERROR_STOP=1 -q -c "update public.ulbra_vinculos set desvinculado_em = now() where ulbra_cliente_id = 'cli-k4' and desvinculado_em is null"
wait
afirma "coleta com vínculo, revogação concorrente" "$(status k4)" "nao_confirmado"

exit $falha
