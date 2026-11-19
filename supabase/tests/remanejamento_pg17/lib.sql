-- Auxiliares de teste (somente CI, banco descartavel PostgreSQL 17).
-- Nada aqui toca producao. Dados sao ficticios.
\set ON_ERROR_STOP on

create or replace function pg_temp.afirma(p_ok boolean, p_msg text) returns void
language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FALHA: %', p_msg; end if;
  raise notice 'ok: %', p_msg;
end $$;

-- sessao como gestao, operador ou anon. `como('')` = sem JWT (cron).
-- Simula o contexto do PostgREST por perfil: claims em request.jwt.claims (sub = uuid
-- derivado do e-mail, role = authenticated). Sem e-mail = sem JWT (cron).
create or replace function pg_temp.como(p_email text) returns void
language plpgsql as $$
declare v jsonb;
begin
  if p_email is null or p_email = '' then
    perform set_config('request.jwt.claims', '', false);
    perform set_config('test.jwt', '', false);
    return;
  end if;
  v := json_build_object('email', p_email, 'sub', md5(p_email)::uuid::text, 'role', 'authenticated')::jsonb;
  perform set_config('request.jwt.claims', v::text, false);
  perform set_config('test.jwt', v::text, false);
end $$;

create or replace function pg_temp.hoje() returns date
language sql stable as $$ select (now() at time zone 'America/Sao_Paulo')::date $$;

-- Semeia 1 aluno + 1 caso + divida em aberto. Devolve os ids.
create or replace function pg_temp.semear(
  p_dono text, p_saldo numeric default 1000, p_dua_dias int default null,
  p_desde_dias int default 30, p_acion text default 'MENSAGEM_ENVIADA',
  p_nao_acionar boolean default false, p_status text default 'Em cobranca'
) returns table(aluno uuid, caso uuid) language plpgsql as $$
declare v_a uuid := gen_random_uuid(); v_c uuid := gen_random_uuid(); v_nome text; v_cpf text;
begin
  v_nome := case p_dono when 'cobranca05@aelbra.com.br' then 'Luana'
                        when 'cobranca06@aelbra.com.br' then 'Mauricio'
                        when 'cobranca13@aelbra.com.br' then 'Diego'
                        when 'cobranca03@aelbra.com.br' then 'Olga'
                        when 'carteira.geral@reativa.local' then 'CARTEIRA GERAL' end;
  v_cpf := lpad((floor(random()*1e11))::bigint::text, 11, '0');
  insert into public.alunos (id, nome, cpf, matricula, responsavel_atual_email, responsavel_atual_nome,
      responsavel_atual_em, data_ultimo_acionamento, status_acionamento)
  values (v_a, 'Aluno '||left(v_a::text,8), v_cpf, 'M'||left(v_a::text,6), p_dono, v_nome,
      now() - make_interval(days => p_desde_dias),
      case when p_dua_dias is null then null else now() - make_interval(days => p_dua_dias) end, p_acion);
  insert into public.casos (id, aluno_id, caso_codigo, nome, cpf, cpf_limpo, matricula, chave_unificacao,
      operador_email, operador_nome, operador, status_atual, status_acionamento, nao_acionar,
      data_ultimo_acionamento, total_em_aberto)
  values (v_c, v_a, floor(random()*1e6)::int, 'Aluno '||left(v_a::text,8), v_cpf, v_cpf,
      'M'||left(v_a::text,6), 'K'||left(v_a::text,8), p_dono, v_nome, upper(coalesce(v_nome,'')), p_status,
      p_acion, p_nao_acionar, case when p_dua_dias is null then null else (pg_temp.hoje() - p_dua_dias) end, p_saldo);
  insert into public.acordos_titulos (aluno_id, cpf, vencimento, valor_original, valor_em_aberto, situacao, status)
  values (v_a, v_cpf, pg_temp.hoje() - 60, p_saldo, p_saldo, 'ABERTO', 'em_aberto');
  return query select v_a, v_c;
end $$;

create or replace function pg_temp.previa(p_alunos uuid[], p_tipo text, p_destino text, p_filtros jsonb default '{}')
returns jsonb language sql as $$
  select public.carteira_geral_previa(p_alunos, p_tipo, p_destino, true, p_filtros, '{}'::uuid[])
$$;

create or replace function pg_temp.lote_de(p_previa jsonb) returns uuid
language sql as $$ select (p_previa->>'previa_id')::uuid $$;

create or replace function pg_temp.dono(p_caso uuid) returns text
language sql as $$ select operador_email from public.casos where id = p_caso $$;

create or replace function pg_temp.marca(p_caso uuid) returns date
language sql as $$ select giro_fidelizacao_ate from public.casos where id = p_caso $$;
