-- B2: negativas provadas por LOGIN NÃO PRIVILEGIADO (session_user = app_teste, membro de authenticated,
-- como o authenticator do PostgREST). NÃO rodar como postgres: postgres/supabase_admin são bypass
-- de manutenção e esconderiam a recusa. Ausência de SET ROLE, claim ausente, claim inconsistente e
-- claim manipulada NUNCA podem conceder acesso.
-- Pré-requisito CI: app_teste LOGIN, membro de authenticated, insert em aluno_movimentacoes.
\set ON_ERROR_STOP on

create or replace function pg_temp.negado(p_sql text) returns text language plpgsql as $$
declare v_state text; v_msg text;
begin
  execute p_sql;
  return 'SEM_ERRO';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  return v_state || '|' || v_msg;
end $$;

-- Sessão 1: operador, sem SET ROLE (conexão direta de LOGIN). Deve ser recusada com mensagem específica.
select set_config('request.jwt.claims', '{"email":"operador.teste@exemplo.local","role":"authenticated"}', false);
do $$
declare r text;
begin
  r := pg_temp.negado($sql$insert into public.aluno_movimentacoes (aluno_id,tipo,status_novo,descricao,registrado_por_email)
       values ('r1','REGISTRO_ADMINISTRATIVO','TERMO_FISICO_EM_ANDAMENTO','Registro administrativo do termo físico.','operador.teste@exemplo.local')$sql$);
  if r not like '42501|Registro administrativo é restrito à gestão. Nada foi gravado.%' then
    raise exception 'FALHOU login direto sem SET ROLE (operador, REGISTRO): %', r; end if;
  r := pg_temp.negado($sql$insert into public.aluno_movimentacoes (aluno_id,tipo,status_novo,registrado_por_email)
       values ('r1','CONTATO','TERMO_FISICO_ARQUIVADO','operador.teste@exemplo.local')$sql$);
  if r not like '42501|A tabulação "TERMO_FISICO_ARQUIVADO" é restrita à gestão.%' then
    raise exception 'FALHOU login direto sem SET ROLE (operador, código restrito): %', r; end if;
end $$;

-- Sessão 2: claim role=service_role, mas sem papel efetivo de serviço: NÃO pode ser bypass.
select set_config('request.jwt.claims', '{"email":"operador.teste@exemplo.local","role":"service_role"}', false);
do $$
declare r text;
begin
  r := pg_temp.negado($sql$insert into public.aluno_movimentacoes (aluno_id,tipo,status_novo,registrado_por_email)
       values ('r1','CONTATO','TERMO_FISICO_ARQUIVADO','operador.teste@exemplo.local')$sql$);
  if r not like '42501|%' then raise exception 'FALHOU claim service_role manipulada concedeu bypass: %', r; end if;
end $$;

-- Sessão 3: claims ausentes e claims inconsistentes (JSON inválido ou vazio).
select set_config('request.jwt.claims', '', false);
do $$
declare r text;
begin
  r := pg_temp.negado($sql$insert into public.aluno_movimentacoes (aluno_id,tipo,status_novo)
       values ('r1','CONTATO','TERMO_FISICO_EM_ANDAMENTO')$sql$);
  if r not like '42501|%' then raise exception 'FALHOU claims vazias concederam acesso: %', r; end if;
end $$;
select set_config('request.jwt.claims', '{nao-e-json', false);
do $$
declare r text;
begin
  r := pg_temp.negado($sql$insert into public.aluno_movimentacoes (aluno_id,tipo,status_novo)
       values ('r1','CONTATO','TERMO_FISICO_EM_ANDAMENTO')$sql$);
  if r not like '22%' and r not like '42501|%' then raise exception 'FALHOU claim inválida não recusada: %', r; end if;
end $$;

-- Sessão 4: RPC direta como operador (PostgREST simulado: authenticated + claim do operador).
select set_config('request.jwt.claims', '{"email":"operador.teste@exemplo.local","role":"authenticated"}', false);
-- EXECUTE da RPC é do papel authenticated (app_teste NOINHERIT não o tem). Chamada como o PostgREST:
-- SET ROLE authenticated, para que a recusa seja a da função (regra de gestão), não falta de grant.
do $$
declare r text;
begin
  set role authenticated;
  r := pg_temp.negado($sql$select public.registrar_administrativo_termo_fisico('r1','TERMO_FISICO_ARQUIVADO')$sql$);
  reset role;
  if r not like '42501|Registro administrativo é restrito à gestão ativa.%' then
    raise exception 'FALHOU RPC como operador: %', r; end if;
end $$;

-- Positivo legítimo permitido ao login não privilegiado: CONTATAR segue o fluxo normal.
-- Como o PostgREST: SET ROLE authenticated (a policy de INSERT é to authenticated).
set role authenticated;
insert into public.aluno_movimentacoes (aluno_id,tipo,status_novo,registrado_por_email)
  values ('r1','CONTATO','CONTATAR','operador.teste@exemplo.local');
reset role;


-- Harness: app_teste não tem helper de gestão ativa nem DML em usuarios (negativas exatas).
do $$
declare r text;
begin
  r := pg_temp.negado($sql$select public.teste_set_ativo('operador.teste@exemplo.local', true)$sql$);
  if r not like '42883|%' then raise exception 'FALHOU: app_teste chamou teste_set_ativo: %', r; end if;
  r := pg_temp.negado($sql$update public.usuarios set ativo = true where email = 'operador.teste@exemplo.local'$sql$);
  if r not like '42501|%' then raise exception 'FALHOU: app_teste alterou usuarios: %', r; end if;
end $$;
select 'OK 09_login_nao_privilegiado' as resultado;
